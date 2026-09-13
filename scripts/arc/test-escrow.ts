// scripts/arc/test-escrow.ts — isolate + exercise ONLY the Arc escrow leg with your key.
// No OpenAI, no Hedera: it just (1) reports the accounts/balances/contract, then
// (2) runs the full lifecycle createJob → fundFee → postBond → release on Arc testnet.
//
//   npx tsx scripts/arc/test-escrow.ts          # diagnose + run the lifecycle
//   npx tsx scripts/arc/test-escrow.ts check    # diagnose only (no transactions)
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: "hardhat/arc/.env" });
config();

import { createPublicClient, http, formatUnits } from "viem";
import {
  arcTestnet, USDC_ADDRESS, USDC_ABI, ESCROW_ABI, ESCROW_ADDRESS,
  explorerTx, explorerAddress,
} from "../../lib/arc/escrow";
import { openAndFundEscrow, resolveEscrow, escrowConfigured, escrowAmounts, escrowAccounts } from "../../lib/arc/escrow-server";
import { getAgentKey } from "../../lib/arc/x402";

const checkOnly = process.argv[2] === "check";

async function main() {
  const pub = createPublicClient({ chain: arcTestnet, transport: http() });

  console.log("\n=== Arc escrow diagnostic ===");
  console.log("chain        :", arcTestnet.name, `(id ${arcTestnet.id})`);
  console.log("escrow       :", ESCROW_ADDRESS, explorerAddress(ESCROW_ADDRESS));
  console.log("usdc (erc20) :", USDC_ADDRESS);

  const hasAgent = !!process.env.ARC_PRIVATE_KEY;
  const hasDev = !!(process.env.ARC_DEVELOPER_KEY || process.env.DEV_ARC_PRIVATE_KEY);
  const hasSeller = !!(process.env.SELLER_PRIVATE_KEY || process.env.AUDITOR_PRIVATE_KEY);
  console.log("keys → ARC_PRIVATE_KEY:", hasAgent, "· ARC_DEVELOPER_KEY:", hasDev, "· SELLER_PRIVATE_KEY:", hasSeller);
  if (!escrowConfigured()) {
    console.log("\n✗ not configured — set ARC_PRIVATE_KEY in .env.local (or hardhat/arc/.env)");
    process.exit(1);
  }

  const { developer, auditor } = escrowAccounts();
  // void unused import guard (getAgentKey is exercised inside escrowAccounts)
  void getAgentKey;

  // balances: USDC (the fee/bond token, 6dp) + native (gas, also USDC on Arc, 18dp)
  const report = async (label: string, addr: string) => {
    const usdc = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [addr as `0x${string}`] }) as bigint;
    const native = await pub.getBalance({ address: addr as `0x${string}` });
    console.log(`${label.padEnd(10)}: ${addr}`);
    console.log(`            USDC(erc20) ${formatUnits(usdc, 6)}  ·  native/gas ${formatUnits(native, 18)}  ·  ${explorerAddress(addr)}`);
    return { usdc, native };
  };
  console.log();
  await report("developer", developer);
  if (auditor.toLowerCase() !== developer.toLowerCase()) await report("auditor", auditor);
  else console.log("auditor   : (same account — single-key mode)");

  // contract sanity: read nextJobId (confirms the escrow is deployed at ESCROW_ADDRESS)
  try {
    const nextId = await pub.readContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "nextJobId", args: [] }) as bigint;
    console.log(`\n✓ escrow contract live — nextJobId = ${nextId}`);
  } catch (e) {
    console.log(`\n✗ escrow contract NOT readable at ${ESCROW_ADDRESS} — needs (re)deploy. ${(e as Error).message}`);
    process.exit(1);
  }

  if (checkOnly) { console.log("\n(check only — no transactions sent)\n"); return; }

  // run the lifecycle
  const amt = escrowAmounts();
  console.log(`\n=== locking escrow: fee ${amt.fee} + bond ${amt.bond} USDC ===`);
  const f = await openAndFundEscrow();
  console.log(`✓ FUNDED  job #${f.jobId}  status ${f.status}`);
  if (f.devApproveTx) console.log(`  dev approve  ↗ ${explorerTx(f.devApproveTx)}`);
  console.log(`  createJob    ↗ ${explorerTx(f.createTx)}`);
  console.log(`  fundFee      ↗ ${explorerTx(f.fundFeeTx)}`);
  if (f.audApproveTx) console.log(`  aud approve  ↗ ${explorerTx(f.audApproveTx)}`);
  console.log(`  postBond     ↗ ${explorerTx(f.postBondTx)}`);

  console.log(`\n=== resolving escrow: release fee + bond → auditor ===`);
  const r = await resolveEscrow(f.jobId);
  console.log(`✓ SETTLED job #${r.jobId}  status ${r.status}  →  ${r.amount} USDC to ${r.paidTo}`);
  console.log(`  release      ↗ ${explorerTx(r.tx)}`);
  console.log(`\nDone. Full lifecycle ran on Arc: Open → Funded → Settled.\n`);
}

main().catch((e) => {
  const err = e as { shortMessage?: string; message?: string };
  console.error("\nERROR:", err.shortMessage || err.message || e);
  process.exit(1);
});

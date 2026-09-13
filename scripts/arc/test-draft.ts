// scripts/arc/test-draft.ts — prove the v2 escrow: open a 0/0 DRAFT job (no price yet),
// then fill the price in with setTerms() after the "discussion". Then fund + release.
//   npx tsx scripts/arc/test-draft.ts
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: "hardhat/arc/.env" });
config();

import { createPublicClient, createWalletClient, http, parseUnits, formatUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { arcTestnet, USDC_ADDRESS, USDC_ABI, ESCROW_ABI, ESCROW_ADDRESS, STATUS_LABELS, explorerTx } from "../../lib/arc/escrow";
import { getAgentKey } from "../../lib/arc/x402";

const U6 = (v: string) => parseUnits(v, 6);

async function main() {
  const account = privateKeyToAccount(getAgentKey());
  const pub = createPublicClient({ chain: arcTestnet, transport: http() });
  const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });
  const write = wallet.writeContract as (a: { address: string; abi: typeof ESCROW_ABI; functionName: string; args: readonly unknown[] }) => Promise<`0x${string}`>;
  const tx = (fn: string, args: readonly unknown[]) =>
    write({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: fn, args }).then(async (h) => { await pub.waitForTransactionReceipt({ hash: h }); return h; });
  const getJob = (id: bigint) => pub.readContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "getJob", args: [id] }) as Promise<{ fee: bigint; bond: bigint; status: number; feeFunded: boolean; bondPosted: boolean }>;
  const show = (j: { fee: bigint; bond: bigint; status: number }) => `fee ${formatUnits(j.fee, 6)} · bond ${formatUnits(j.bond, 6)} · ${STATUS_LABELS[j.status]}`;

  console.log("\n=== v3 escrow draft test ===  contract", ESCROW_ADDRESS, "\naccount", account.address);

  const jobId = await pub.readContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "nextJobId", args: [] }) as bigint;

  console.log(`\n1) createJob with 0/0 (no price yet) …`);
  const createTx = await tx("createJob", [account.address, account.address, 0n, 0n]);
  console.log(`   ✓ job #${jobId} created  (${show(await getJob(jobId))})  ↗ ${explorerTx(createTx)}`);

  console.log(`\n2) approve the escrow (once) …`);
  const allowance = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "allowance", args: [account.address, ESCROW_ADDRESS] }) as bigint;
  if (allowance < U6("0.03")) { const a = await wallet.writeContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "approve", args: [ESCROW_ADDRESS, U6("1000")] }); await pub.waitForTransactionReceipt({ hash: a }); console.log(`   approve ↗ ${explorerTx(a)}`); }

  console.log(`\n3) fundFee(jobId, 0.01) — amount passed AT fund time, no price set beforehand …`);
  const fundTx = await tx("fundFee", [jobId, U6("0.01")]);
  console.log(`   ✓ fee funded  (${show(await getJob(jobId))})  ↗ ${explorerTx(fundTx)}`);

  console.log(`\n4) postBond(jobId, 0.02) — independent amount …`);
  const bondTx = await tx("postBond", [jobId, U6("0.02")]);
  console.log(`   ✓ bond posted → Funded  (${show(await getJob(jobId))})  ↗ ${explorerTx(bondTx)}`);

  console.log(`\n5) release → fee + bond to auditor …`);
  const relTx = await tx("release", [jobId]);
  console.log(`   ✓ settled  (${show(await getJob(jobId))})  ↗ ${explorerTx(relTx)}`);
  console.log(`\nDone — draft (0/0) → fundFee(0.01) → postBond(0.02) → Settled all worked.\n`);
}

main().catch((e) => { const err = e as { shortMessage?: string; message?: string }; console.error("\nERROR:", err.shortMessage || err.message || e); process.exit(1); });

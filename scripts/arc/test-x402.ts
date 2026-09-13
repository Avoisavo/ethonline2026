// scripts/arc/test-x402.ts — prove a real x402 / Circle Gateway NANOPAYMENT with your key.
// Unlike the escrow (on-chain contract, gas per tx), this spends your GATEWAY balance ("gw"):
// the agent hits the 402-protected /api/arc/skill, signs an offchain EIP-3009 authorization, and
// Circle Gateway settles it gas-free. Pays SKILL_SELLER (a DIFFERENT address — x402 forbids
// self-transfer). Requires the dev server running (it calls http://localhost:3000/api/arc/skill).
//
//   npx tsx scripts/arc/test-x402.ts
import { config } from "dotenv";
config({ path: ".env.local" });
config({ path: "hardhat/arc/.env" });
config();

import { GatewayClient } from "@circle-fin/x402-batching/client";
import { formatUnits, parseUnits } from "viem";
import { getAgentKey, SKILL_SELLER } from "../../lib/arc/x402";

const URL = process.env.X402_URL || "http://localhost:3000/api/arc/skill"; // payTo defaults to SKILL_SELLER

const fmt = (v: unknown) => {
  try { return formatUnits(BigInt(v as string | bigint), 6); } catch { return String(v); }
};

async function main() {
  const client = new GatewayClient({ chain: "arcTestnet", privateKey: getAgentKey() });
  console.log("\n=== x402 nanopayment ===");
  console.log("agent  :", client.address);
  console.log("seller :", SKILL_SELLER, client.address.toLowerCase() === SKILL_SELLER.toLowerCase() ? "  ⚠ SAME as agent → self-transfer will fail" : "  (different ✓)");

  const before = await client.getBalances();
  console.log("gateway available (gw) before:", fmt(before.gateway.available), "USDC");

  // top up the Gateway balance once if it's too low for a 0.01 payment
  if (before.gateway.available < parseUnits("0.01", 6)) {
    console.log("gw too low — depositing 1 USDC into Gateway (onchain, gas)…");
    await client.deposit("1");
  }

  const sup = await client.supports(URL);
  console.log("endpoint supports x402:", sup.supported);
  if (!sup.supported) throw new Error(`/api/arc/skill did not advertise x402 (is the dev server up at ${URL}?) ${sup.error ?? ""}`);

  console.log("paying via x402 (402 → sign EIP-3009 → Gateway settle, gas-free)…");
  const res = await client.pay(URL);
  console.log(`✓ PAID ${res.formattedAmount} USDC via x402`);
  console.log("  settlement tx :", res.transaction);
  console.log("  verified link :", (res.data as { verifiedLink?: string })?.verifiedLink ?? "—");

  const after = await client.getBalances();
  console.log("gateway available (gw) after :", fmt(after.gateway.available), "USDC");
  console.log("  (the drop = the nanopayment; settles to the seller's Gateway balance, gas-free)\n");
}

main().catch((e) => {
  const err = e as { shortMessage?: string; message?: string };
  console.error("\nERROR:", err.shortMessage || err.message || e);
  process.exit(1);
});

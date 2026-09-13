import type { NextApiRequest, NextApiResponse } from "next";
import { createPublicClient, formatUnits, http } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { FACILITATOR_URL, getAgentKey } from "@/lib/arc/x402";
import { GATEWAY_DOMAIN, USDC_ABI, USDC_ADDRESS, arcTestnet } from "@/lib/arc/escrow";

// Returns the agent wallet's address + on-chain USDC + Circle Gateway balance.
export default async function handler(_req: NextApiRequest, res: NextApiResponse) {
  try {
    const address = privateKeyToAccount(getAgentKey()).address;
    const pub = createPublicClient({ chain: arcTestnet, transport: http() });
    const wallet = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [address] });
    const gw = await fetch(`${FACILITATOR_URL}/v1/balances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "USDC", sources: [{ depositor: address, domain: GATEWAY_DOMAIN }] }),
    }).then((r) => r.json());
    const b = gw?.balances?.[0];
    return res.status(200).json({
      address,
      walletUsdc: formatUnits(wallet, 6),
      gatewayAvailable: b?.balance ?? "0",
      gatewayPending: b?.pendingBatch ?? "0",
    });
  } catch (e: unknown) {
    return res.status(500).json({ error: (e as { message?: string }).message || "agent lookup failed" });
  }
}

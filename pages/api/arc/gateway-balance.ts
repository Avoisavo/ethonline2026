import type { NextApiRequest, NextApiResponse } from "next";
import { FACILITATOR_URL } from "@/lib/arc/x402";
import { GATEWAY_DOMAIN } from "@/lib/arc/escrow";

// Reads an address's Circle Gateway balance (server-side proxy to avoid CORS).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const address = String(req.query.address ?? "");
  if (!/^0x[0-9a-fA-F]{40}$/.test(address)) {
    return res.status(400).json({ error: "valid ?address= required" });
  }
  try {
    const r = await fetch(`${FACILITATOR_URL}/v1/balances`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ token: "USDC", sources: [{ depositor: address, domain: GATEWAY_DOMAIN }] }),
    });
    const data = await r.json();
    const b = data?.balances?.[0];
    return res.status(200).json({
      available: b?.balance ?? "0",
      pendingBatch: b?.pendingBatch ?? "0",
      registered: !!b && Number(b.balance) >= 0 && b.balance !== undefined,
    });
  } catch (e: unknown) {
    const err = e as { message?: string };
    return res.status(500).json({ error: err.message || "lookup failed" });
  }
}

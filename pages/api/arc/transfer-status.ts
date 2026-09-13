import type { NextApiRequest, NextApiResponse } from "next";
import { FACILITATOR_URL } from "@/lib/arc/x402";

// Looks up an x402 transfer's settlement status by id (server-side, avoids CORS).
// Lifecycle: received -> batched -> confirmed -> completed (or failed).
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  const id = String(req.query.id ?? "");
  if (!id) return res.status(400).json({ error: "?id= required" });
  try {
    const r = await fetch(`${FACILITATOR_URL}/v1/x402/transfers/${id}`);
    if (!r.ok) {
      return res.status(200).json({ status: "pending", note: `not indexed yet (${r.status})` });
    }
    const t = await r.json();
    return res.status(200).json({
      status: t.status ?? "unknown",
      amount: t.amount,
      from: t.fromAddress,
      to: t.toAddress,
      updatedAt: t.updatedAt,
    });
  } catch (e: unknown) {
    const err = e as { message?: string };
    return res.status(500).json({ error: err.message || "lookup failed" });
  }
}

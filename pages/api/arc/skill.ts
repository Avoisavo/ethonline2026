import type { NextApiRequest, NextApiResponse } from "next";
import { FACILITATOR_URL, PRICE_DISPLAY, SKILL_SELLER, skillRequirement } from "@/lib/arc/x402";

// The "verified skill" being sold. In production this would be looked up from the
// HCS registry + the content-pinned verified link for the audited version.
const SKILL = { id: "price-checker", name: "Price Checker", version: "1.0.0", verdict: "SAFE" };

// x402-protected resource: returns 402 until a valid Gateway payment is attached,
// then settles it via Circle Gateway and serves the verified link.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Recipient = the job's creator (passed by the buyer), falls back to the default seller.
  const payToQ = String(req.query.payTo ?? "");
  const payTo = /^0x[0-9a-fA-F]{40}$/.test(payToQ) ? payToQ : SKILL_SELLER;
  const amountQ = String(req.query.amount ?? "");
  const amount = /^\d+$/.test(amountQ) && Number(amountQ) > 0 ? amountQ : undefined;
  const requirement = skillRequirement(payTo, amount);
  const sig = req.headers["payment-signature"] as string | undefined;

  // 1) Unpaid request -> 402 Payment Required with the x402 PAYMENT-REQUIRED header.
  if (!sig) {
    const resource = {
      url: `https://${req.headers.host}/api/arc/skill`,
      description: `ethonlineArc verified skill: ${SKILL.name}`,
      mimeType: "application/json",
    };
    const paymentRequired = Buffer.from(
      JSON.stringify({ x402Version: 2, resource, accepts: [requirement] }),
    ).toString("base64");
    res.setHeader("PAYMENT-REQUIRED", paymentRequired);
    return res.status(402).json({ error: "Payment required", price: `${PRICE_DISPLAY} USDC`, payTo: SKILL_SELLER });
  }

  // 2) Paid request -> decode the signed payload and settle it via Circle Gateway.
  let paymentPayload: unknown;
  try {
    paymentPayload = JSON.parse(Buffer.from(sig, "base64").toString("utf-8"));
  } catch {
    return res.status(400).json({ error: "Malformed Payment-Signature header" });
  }

  const settleRes = await fetch(`${FACILITATOR_URL}/v1/x402/settle`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ paymentPayload, paymentRequirements: requirement }),
  });
  const settle = await settleRes.json().catch(() => ({}));

  if (!settle?.success) {
    return res.status(402).json({ error: settle?.errorReason || "Settlement failed" });
  }

  // 3) Settled -> serve the resource + the x402 PAYMENT-RESPONSE header.
  res.setHeader("PAYMENT-RESPONSE", Buffer.from(JSON.stringify(settle)).toString("base64"));
  return res.status(200).json({
    unlocked: true,
    skill: SKILL,
    verifiedLink: `https://${req.headers.host}/v/${SKILL.id}@${SKILL.version}?lic=${String(settle.transaction || "").slice(0, 10)}`,
    payer: settle.payer,
    settlementTx: settle.transaction,
  });
}

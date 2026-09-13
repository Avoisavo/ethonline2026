import type { NextApiRequest, NextApiResponse } from "next";
import { GatewayClient } from "@circle-fin/x402-batching/client";
import { createPublicClient, formatUnits, http, parseUnits } from "viem";
import { PRICE_BASE_UNITS, getAgentKey } from "@/lib/arc/x402";
import { ESCROW_ABI, ESCROW_ADDRESS, arcTestnet } from "@/lib/arc/escrow";

const ZERO = "0x0000000000000000000000000000000000000000";

// An AI agent pays per-use for a verified skill, gas-free, via x402 — and SPLITS the
// fee between the job's author (developer) and auditor per the requested percentage.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }

  try {
    const jobId = Number(req.body?.jobId ?? 0);
    if (!jobId) return res.status(400).json({ error: "jobId required" });
    let authorPct = Math.round(Number(req.body?.authorPct ?? 80));
    if (!Number.isFinite(authorPct)) authorPct = 80;
    authorPct = Math.max(0, Math.min(100, authorPct));

    // Author (developer) + auditor, read from the escrow.
    const pub = createPublicClient({ chain: arcTestnet, transport: http() });
    const job = await pub.readContract({
      address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "getJob", args: [BigInt(jobId)],
    });
    if (!job || job.developer === ZERO) return res.status(400).json({ error: `Job #${jobId} not found` });
    const author = job.developer;
    const auditor = job.auditor;

    const total = Number(PRICE_BASE_UNITS); // 10000 base units = 0.01 USDC
    const authorAmt = Math.round((total * authorPct) / 100);
    const auditorAmt = total - authorAmt;

    const client = new GatewayClient({ chain: "arcTestnet", privateKey: getAgentKey() });
    const agent = client.address.toLowerCase();

    // Build the split recipients (collapse to one if author == auditor).
    const recipients: { role: string; to: string; amount: number }[] = [];
    if (author.toLowerCase() === auditor.toLowerCase()) {
      recipients.push({ role: "author+auditor", to: author, amount: total });
    } else {
      if (authorAmt > 0) recipients.push({ role: "author", to: author, amount: authorAmt });
      if (auditorAmt > 0) recipients.push({ role: "auditor", to: auditor, amount: auditorAmt });
    }
    for (const r of recipients) {
      if (r.to.toLowerCase() === agent) {
        return res.status(400).json({
          error: `${r.role} (${r.to}) is the paying agent itself (self-transfer). Use a job whose author/auditor differ from the agent.`,
        });
      }
    }

    // Fund the agent's Gateway balance if needed (one-time).
    let deposited = false;
    const balances = await client.getBalances();
    if (balances.gateway.available < parseUnits("0.01", 6)) {
      await client.deposit("1");
      deposited = true;
    }

    // Pay each recipient via x402 (gas-free), with that recipient's split amount.
    const proto = (req.headers["x-forwarded-proto"] as string) || "http";
    const base = `${proto}://${req.headers.host}`;
    const payments: { role: string; to: string; amount: string; tx: string }[] = [];
    let verifiedLink: string | undefined;
    for (const r of recipients) {
      const url = `${base}/api/arc/skill?payTo=${r.to}&amount=${r.amount}&jobId=${jobId}`;
      const result = await client.pay(url);
      payments.push({ role: r.role, to: r.to, amount: formatUnits(BigInt(r.amount), 6), tx: result.transaction });
      verifiedLink = (result.data as { verifiedLink?: string })?.verifiedLink ?? verifiedLink;
    }

    return res.status(200).json({
      ok: true,
      agent: client.address,
      jobId,
      author,
      auditor,
      authorPct,
      total: formatUnits(BigInt(total), 6),
      payments,
      verifiedLink,
      deposited,
    });
  } catch (err: unknown) {
    const e = err as { shortMessage?: string; message?: string };
    return res.status(500).json({ error: e.shortMessage || e.message || "payment failed" });
  }
}

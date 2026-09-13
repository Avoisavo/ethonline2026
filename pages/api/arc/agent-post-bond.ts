import type { NextApiRequest, NextApiResponse } from "next";
import { createPublicClient, createWalletClient, http, parseUnits } from "viem";
import { privateKeyToAccount } from "viem/accounts";
import { getAgentKey } from "@/lib/arc/x402";
import { ESCROW_ABI, ESCROW_ADDRESS, USDC_ABI, USDC_ADDRESS, arcTestnet } from "@/lib/arc/escrow";

const ZERO = "0x0000000000000000000000000000000000000000";

// The agent acts as the AUDITOR: approve the escrow (once) + post the bond for a job.
export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  if (req.method !== "POST") {
    res.setHeader("Allow", "POST");
    return res.status(405).json({ error: "POST only" });
  }
  try {
    const jobId = Number(req.body?.jobId ?? 0);
    if (!jobId) return res.status(400).json({ error: "jobId required" });
    // bond amount (base units, 6-dec USDC) — passed at post time so the UI sets it independently.
    // Falls back to the amount already stored on the job (e.g. set via createJob/setTerms).
    const bondArg = req.body?.bond != null ? BigInt(req.body.bond) : null;

    const account = privateKeyToAccount(getAgentKey());
    const pub = createPublicClient({ chain: arcTestnet, transport: http() });
    const wallet = createWalletClient({ account, chain: arcTestnet, transport: http() });

    const job = await pub.readContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "getJob", args: [BigInt(jobId)] });
    if (!job || job.developer === ZERO) return res.status(400).json({ error: `Job #${jobId} not found` });
    if (job.auditor.toLowerCase() !== account.address.toLowerCase()) {
      return res.status(400).json({ error: `Job #${jobId} auditor isn't the agent — create the job with auditor = agent` });
    }
    if (job.bondPosted) return res.status(400).json({ error: "bond already posted" });

    // the bond to lock = the explicit amount from the request, else the job's stored bond
    const bond = bondArg != null && bondArg > 0n ? bondArg : job.bond;
    if (bond <= 0n) return res.status(400).json({ error: "bond must be > 0 — pass a bond amount" });

    const bal = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "balanceOf", args: [account.address] });
    if (bal < bond) return res.status(400).json({ error: "agent USDC balance too low for the bond" });

    // one-time: approve the escrow to pull the agent's USDC
    const allowance = await pub.readContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "allowance", args: [account.address, ESCROW_ADDRESS] });
    let approveTx: string | undefined;
    if (allowance < bond) {
      approveTx = await wallet.writeContract({ address: USDC_ADDRESS, abi: USDC_ABI, functionName: "approve", args: [ESCROW_ADDRESS, parseUnits("1000", 6)] });
      await pub.waitForTransactionReceipt({ hash: approveTx as `0x${string}` });
    }

    const tx = await wallet.writeContract({ address: ESCROW_ADDRESS, abi: ESCROW_ABI, functionName: "postBond", args: [BigInt(jobId), bond] });
    await pub.waitForTransactionReceipt({ hash: tx });
    return res.status(200).json({ ok: true, tx, approveTx });
  } catch (err: unknown) {
    const e = err as { shortMessage?: string; message?: string };
    return res.status(500).json({ error: e.shortMessage || e.message || "post bond failed" });
  }
}

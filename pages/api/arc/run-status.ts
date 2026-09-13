// pages/api/arc/run-status.ts — live progress for an async /api/arc/run-task (?async=1).
//
// An agent (e.g. Hermes) whose tool UI buffers a single long call kicks the audit off with
// `?async=1`, then POLLS this every few seconds. Each poll returns the current stage + a
// ready-to-print `line`, so the steps appear one at a time in the agent's view.
//
//   GET /api/arc/run-status   → { phase, done, stage, line, verdict, … } for the latest async run
import type { NextApiRequest, NextApiResponse } from "next";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { loadState } from "@/lib/hederaone/state";

const AUDITS = join(process.cwd(), "db", "audits.json");
const STAGES = ["Scanner", "Sandbox", "Fork", "Synthesizer"];

/* eslint-disable @typescript-eslint/no-explicit-any */
export default function handler(_req: NextApiRequest, res: NextApiResponse) {
  res.setHeader("Cache-Control", "no-store");

  let db: Record<string, any> = {};
  try { db = JSON.parse(readFileSync(AUDITS, "utf8")); } catch { /* no audits yet */ }

  // Only consider the run started by the most recent ?async=1 kickoff (small skew so we
  // don't miss it), so old completed audits of the same skill don't read as "done".
  const since = (loadState().lastRunKickoff || 0) - 8000;
  const r = Object.values(db)
    .filter((a) => Date.parse(a.started_at || 0) >= since)
    .sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")))[0];

  // kicked off, but the on-chain task topic + audit record aren't created yet (the task is
  // being posted, negotiated, and the escrow funded — ~10-15s before the audit record appears)
  if (!r) {
    return res.status(200).json({ phase: "starting", done: false, line: "📡 posting the task, negotiating, and locking the Arc escrow on Hedera…" });
  }

  const ev: any[] = Array.isArray(r.evidence) ? r.evidence : [];
  const done = r.status === "audited" || r.status === "failed";
  const curStage = done ? 4 : Math.max(1, Math.min(4, r.stage || 1));
  const steps = ev.map((e, i) => ({ n: i + 1, stage: STAGES[i] || e.stage, summary: e.summary || "" }));

  let line: string;
  if (r.status === "failed") {
    line = `❌ audit failed: ${r.error || "unknown error"}`;
  } else if (done) {
    line = r.verdict === "SAFE"
      ? `✅ VERDICT: SAFE (risk ${r.risk}) — verified & licensed; installing.`
      : `⛔ VERDICT: ${r.verdict} (risk ${r.risk}) — flagged, NOT installed.`;
  } else if (curStage >= 4 || steps.length >= 3) {
    // synthesizer + the on-chain tail (HCS trail, VERIFIED NFT mint, escrow settle) — the longest leg
    line = `✓ all stages clear · Synthesizer sealing the attested verdict, minting the VERIFIED NFT & settling the escrow…`;
  } else if (steps.length) {
    const last = steps[steps.length - 1];
    line = `✓ ${last.stage}: ${last.summary}  ▸ now stage ${curStage}/4 · ${STAGES[curStage - 1]}…`;
  } else {
    line = `🔍 auditing · stage ${curStage}/4 · ${STAGES[curStage - 1]}…`;
  }

  return res.status(200).json({
    phase: done ? "done" : "running",
    done,
    skill: r.skill,
    task_topic: r.audit_id,
    chat_room: r.chat_room || null,
    status: r.status,
    stage: curStage,
    stage_name: r.stage_name || STAGES[curStage - 1],
    verdict: r.verdict || null,
    risk: r.risk || null,
    verified_name: r.verified_name || null,
    steps,
    line,
  });
}

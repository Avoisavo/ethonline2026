// pages/api/arc/run-task.ts — the ethonlineArc task flow as a streaming, curl-able endpoint.
//
// This is a THIN wrapper: it parses the query params, opens a plain-text stream, and
// hands everything to runTaskFlow() in lib/arc/task-flow.ts (the same code the CLI runs).
// All the real work — negotiate → audit → persist → whitelist → review/mint — lives there.
//
// An agent calls it with its account id + the skill/MCP it wants to use; the endpoint
// streams live progress (negotiation, the 4 audit stages, verdict, attestation, the
// review + NFT) and ends with one machine-readable RESULT json line. Use `curl -N` so
// curl doesn't buffer — you see each line as it happens.
//
//   curl -N "http://localhost:3000/api/arc/run-task?agent_id=0.0.9227937&skill=safe-weather-skill"
//   curl -N "http://localhost:3000/api/arc/run-task?agent_id=0.0.9228428&skill=https://raw.githubusercontent.com/owner/repo/main/SKILL.md"
//   curl -N "http://localhost:3000/api/arc/run-task?agent_id=0.0.9228428&skill=left-pad"
//
// Params:
//   agent_id  — the requester account; whitelisted into the skill's licensed_agents on SAFE
//   skill     — local path | demo name | npm package | github raw url (the MCP/skill to audit)
import type { NextApiRequest, NextApiResponse } from "next";
import { runTaskFlow } from "@/lib/arc/task-flow";
import { saveState } from "@/lib/hederaone/state";

// The real audit + Hedera round-trips take a while (OpenAI stages + several HCS submits +
// an NFT mint), so disable Next's response size limit and allow up to 5 minutes.
export const config = { api: { responseLimit: false }, maxDuration: 300 };

export default async function handler(req: NextApiRequest, res: NextApiResponse) {
  // Accept the params from the query string (GET) or the JSON body (POST). agent_id is the
  // requester; skill is what to audit (several aliases accepted so curl is forgiving).
  const q = req.method === "POST" ? { ...req.query, ...(req.body ?? {}) } : req.query;
  const agentId = String(q.agent_id ?? q.agentId ?? "").trim();
  const skillRef = String(q.skill ?? q.ref ?? q.package ?? "").trim();

  // ── ASYNC mode (?async=1): kick the flow off in the background and return immediately.
  // Progress lands live in db/audits.json — poll /api/arc/run-status to watch the stages. This
  // is for agents (like Hermes) whose tool UI buffers a single long call's output: they
  // poll instead, so each short poll renders as the stages complete.
  if (q.async === "1" || q.async === "true") {
    if (!skillRef) return res.status(400).json({ error: "pass ?skill=…" });
    saveState({ lastRunKickoff: Date.now() }); // marker so /api/arc/run-status finds THIS run
    runTaskFlow({ agentId, skillRef, color: false, write: () => {} }).catch((e) =>
      console.error("async run-task failed:", e instanceof Error ? e.message : e)
    );
    res.setHeader("Cache-Control", "no-store");
    return res.status(200).json({ ok: true, started: true, skill: skillRef, poll: "/api/arc/run-status", note: "audit running in the background — poll /api/arc/run-status every few seconds for live stages" });
  }

  // Stream plain text: no caching, no proxy buffering, so `curl -N` shows lines live.
  res.writeHead(200, {
    "Content-Type": "text/plain; charset=utf-8",
    "Cache-Control": "no-store, no-transform",
    "X-Accel-Buffering": "no",
  });
  const w = (s = "") => res.write(s + "\n"); // write one line to the stream

  if (!skillRef) {
    w("ERROR: pass ?skill=<local path | demo name | npm package | github raw url>");
    return void res.end();
  }

  try {
    w(`\n  ethonlineArc · audit + license`);
    w(`  agent ${agentId || "(none — using demo requester)"}`);
    w(`  skill ${skillRef}`);

    // Run the whole lifecycle. color:false → plain text for curl (no ANSI escapes); each
    // progress line is streamed to the client through `w` as it happens.
    const result = await runTaskFlow({ agentId, skillRef, color: false, write: w });

    // Final compact, machine-readable summary line — easy for a calling agent to parse.
    // (audit_id == task_topic: both are the HCS topic that holds the full audit trail.)
    w(`RESULT ${JSON.stringify({
      skill: result.skill,
      verdict: result.verdict,
      trust: result.trust,
      licensed: result.licensed,
      requester: result.requester,
      audit_id: result.auditId,
      task_topic: result.taskTopicId,
      attested: result.attested,
      decision: result.decision,
      nft: result.mint ? `${result.mint.tokenId}#${result.mint.serial}` : null,
    })}`);
  } catch (e: unknown) {
    w(`\nERROR: ${e instanceof Error ? e.message : "task flow failed"}`);
  } finally {
    res.end();
  }
}

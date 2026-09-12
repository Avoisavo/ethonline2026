// lib/audit-task.ts — SERVER-ONLY. The audit half of a task: run derek's REAL audit pipeline
// (lib/audit-core.mjs — 4 OpenAI stages: scanner→sandbox→fork→synthesizer) over the skill source,
// then RECORD EACH PART onto the task's HCS topic:
//   • one `mars-audit` stage message per stage (summary + findings)
//   • the full untruncated report → HCS-1 (content-addressed)
//   • the verdict message (verdict + risk + CAPABILITIES "what the skill does" + recommendation)
//   • a `job_updated` into the main registry → so the dashboard can later list verified skills.
// Falls back to the canned demo stages/verdict when OPENAI_API_KEY is absent, so the demo never breaks.
// Used by the /api/hedera `runAudit` action and scripts/run-task.ts.
import type { Client } from "@hashgraph/sdk";
import {
  submitMessage,
  uploadFileHCS1,
  buildAuditStage,
  buildAuditVerdictFull,
  buildJobUpdated,
  buildTaskDecision,
  buildTaskReviewed,
  buildTaskMinted,
  buildReview,
  buildHCS20Mint,
  createVerifiedCollection,
  mintNft,
  transferNft,
  getOperatorId,
  riskToTrust,
  type AuditFinding,
} from "./hedera";
import { getSkill, FALLBACK_CAPABILITIES } from "./demo-skills";
import { loadState, saveState } from "./state";
// derek's shared pipeline + loader (.mjs, allowJs)
import { runAuditPipeline, DEFAULT_MODEL } from "./audit-core.mjs";
import { resolveLocalDemoSkill } from "./skill-source.mjs";

export interface AuditStageResult {
  stage: string;
  status: "pass" | "warn" | "fail";
  summary: string;
  findings: AuditFinding[];
}
export interface AuditTaskResult {
  verdict: "SAFE" | "DANGEROUS";
  risk: string;
  trustScore: number;
  capabilities: string[];
  summary: string;
  recommendation: string;
  reportHrl: string;
  source: "openai" | "fallback";
  stages: AuditStageResult[];
}

const STAGE_LABEL: Record<string, string> = { scanner: "Scanner", sandbox: "Sandbox", fork: "Fork" };
const SEV_RANK: Record<string, number> = { none: 0, low: 1, medium: 2, high: 3, critical: 4 };
function statusOf(findings: AuditFinding[]): "pass" | "warn" | "fail" {
  const worst = findings.reduce((m, f) => Math.max(m, SEV_RANK[String(f.severity).toLowerCase()] ?? 0), 0);
  return worst >= 3 ? "fail" : worst === 2 ? "warn" : "pass";
}

export interface AuditTaskOpts {
  taskTopicId: string;
  skillRef: string;
  files?: { name: string; content: string }[]; // author-submitted source (paste/upload/URL); else resolved from a demo ref
  skillName?: string;
  registryTopicId?: string;
  onStage?: (s: AuditStageResult) => void;
  onVerdict?: (v: { verdict: string; risk: string; capabilities: string[] }) => void;
}

export async function auditTaskToHcs(client: Client, opts: AuditTaskOpts): Promise<AuditTaskResult> {
  const { taskTopicId, skillRef, files, registryTopicId, onStage, onVerdict } = opts;
  const cfg = getSkill(skillRef);
  const skillName = opts.skillName ?? cfg?.name ?? skillRef.replace(/\.(js|json|md)$/i, "");
  const apiKey = process.env.OPENAI_API_KEY;
  const modelUsed = apiKey ? (process.env.AUDIT_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL) : "deterministic";

  let stages: AuditStageResult[] = [];
  let verdict: "SAFE" | "DANGEROUS" = "SAFE";
  let risk = "low";
  let summary = "";
  let capabilities: string[] = [];
  let recommendation = "";
  let trustScore = 50;
  let source: "openai" | "fallback";
  let fullReport: unknown;
  let attestation: string | undefined;

  if (apiKey) {
    // ── real pipeline ──────────────────────────────────────────────
    source = "openai";
    // Prefer author-submitted files; otherwise resolve a demo ref from disk.
    const loaded = files?.length
      ? { name: skillName, files }
      : ((resolveLocalDemoSkill(skillRef) as { name: string; files: { name: string; content: string }[] } | null) ?? { name: skillName, files: [] });
    const result = (await runAuditPipeline({
      name: loaded.name,
      files: loaded.files,
      apiKey,
      model: process.env.AUDIT_MODEL || process.env.OPENAI_MODEL || DEFAULT_MODEL,
      attestorUrl: process.env.PHALA_ATTESTOR_URL, // optional TEE seal; undefined → skipped
      auditId: undefined,
    })) as {
      record: { evidence: { stage: string; summary: string; findings: AuditFinding[] }[] };
      verdict: { verdict: "SAFE" | "DANGEROUS"; risk: string; summary: string; capabilities?: string[]; recommendation?: string; findings?: AuditFinding[] };
      attestation?: { reportData?: string; error?: string } | null;
    };
    stages = result.record.evidence.map((e) => ({
      stage: STAGE_LABEL[e.stage] ?? e.stage,
      status: statusOf(e.findings || []),
      summary: e.summary || "",
      findings: e.findings || [],
    }));
    verdict = result.verdict.verdict;
    risk = result.verdict.risk || (verdict === "SAFE" ? "low" : "high");
    summary = result.verdict.summary || "";
    capabilities = result.verdict.capabilities || [];
    recommendation = result.verdict.recommendation || "";
    trustScore = riskToTrust(risk);
    attestation = result.attestation?.reportData && !result.attestation.error ? `0x${String(result.attestation.reportData).replace(/^0x/, "").slice(0, 48)}` : undefined;
    fullReport = { ...result.record, verdict: result.verdict, attestation: result.attestation ?? null };
  } else {
    // ── deterministic fallback (no key) ────────────────────────────
    source = "fallback";
    const canned = (cfg?.steps ?? []).filter((s) => s.name !== "Synthesizer");
    stages = canned.map((s) => ({ stage: s.name, status: s.status === "info" ? "warn" : s.status, summary: s.detail, findings: [] }));
    verdict = cfg?.expect ?? "SAFE";
    risk = verdict === "SAFE" ? (cfg && cfg.trust >= 90 ? "none" : "low") : "critical";
    trustScore = cfg?.trust ?? riskToTrust(risk);
    capabilities = FALLBACK_CAPABILITIES[skillRef] ?? [];
    summary = `Deterministic demo audit for "${skillName}" (no OPENAI_API_KEY — set it for the live pipeline).`;
    recommendation = verdict === "SAFE" ? "List as a verified skill." : "Block — do not list; flag DANGEROUS.";
    fullReport = { skill: skillName, verdict, risk, trustScore, capabilities, stages, fallback: true, audited_at: new Date().toISOString() };
  }

  // ── record each stage onto the task HCS topic (ordered; the UI polls and shows them appear) ──
  for (const st of stages) {
    onStage?.(st);
    await submitMessage(client, taskTopicId, buildAuditStage(skillName, st.stage, st.summary, st.findings, modelUsed));
  }

  // ── full report → HCS-1 (immutable, content-addressed) ──
  const file = await uploadFileHCS1(client, JSON.stringify(fullReport), "application/json");

  // ── verdict (carries capabilities = "what the skill does") → task topic ──
  onVerdict?.({ verdict, risk, capabilities });
  await submitMessage(
    client,
    taskTopicId,
    buildAuditVerdictFull(skillName, { verdict, risk, summary, capabilities, recommendation, trustScore, model: modelUsed, reportHrl: file.hrl, attestation })
  );

  // ── index into the main registry. The audit only marks the job "audited" (+ the verdict); a skill
  //    becomes "verified" ONLY when the requester approves (finalizeTaskToHcs), never from the audit alone. ──
  if (registryTopicId) {
    await submitMessage(
      client,
      registryTopicId,
      buildJobUpdated({ jobId: taskTopicId, status: "audited", verdict, trustScore, note: summary.slice(0, 120) })
    );
  }

  return { verdict, risk, trustScore, capabilities, summary, recommendation, reportHrl: file.hrl, source, stages };
}

// ════════════════════════════════════════════════════════════════════════════
// Post-audit lifecycle: requester DECISION → REVIEW the auditor → mint a VERIFIED HTS NFT.
// All three are recorded on the task topic (more rows in the trail); the review also writes to the
// auditor's OWN review + good/bad voting HCS, and the mint delivers an HTS NFT to the requester.
// ════════════════════════════════════════════════════════════════════════════
export interface FinalizeOpts {
  taskTopicId: string;
  skill: string;
  verdict: "SAFE" | "DANGEROUS";
  approve: boolean;
  rating?: number;
  comment?: string;
  requester: string;
  auditor: string;
  reviewTopicId?: string;
  votingTopicId?: string;
  registryTopicId?: string;
  mintToAccountId?: string; // deliver the VERIFIED NFT here (the requester)
}
export interface FinalizeResult {
  decision: "approved" | "disapproved";
  rating: number;
  comment: string;
  reviewSeq?: string;
  voteSeq?: string;
  mint?: { tokenId: string; serial: string; metadata: string; owner: string; transferred: boolean };
}

export async function finalizeTaskToHcs(client: Client, opts: FinalizeOpts): Promise<FinalizeResult> {
  const { taskTopicId, skill, verdict, approve, requester, auditor, reviewTopicId, votingTopicId, registryTopicId, mintToAccountId } = opts;
  const rating = Math.max(1, Math.min(5, Math.round(opts.rating ?? 5)));
  const comment = opts.comment ?? (verdict === "SAFE" ? "Thorough, accurate audit — clean verdict." : "Caught the malicious behavior — great catch.");
  const decision: "approved" | "disapproved" = approve ? "approved" : "disapproved";

  // 1) requester decision → task topic
  await submitMessage(client, taskTopicId, buildTaskDecision(skill, requester, decision, verdict, approve ? "Verdict accepted by requester" : "Verdict rejected / skill blocked by requester"));

  // 2) rate + review the auditor → its OWN review + voting HCS, and a task-topic record
  let reviewSeq: string | undefined;
  let voteSeq: string | undefined;
  if (reviewTopicId) reviewSeq = (await submitMessage(client, reviewTopicId, buildReview({ target: auditor, reviewer: requester, rating, comment, role: "auditor" }))).sequenceNumber;
  if (votingTopicId) voteSeq = (await submitMessage(client, votingTopicId, buildHCS20Mint("good", String(rating), auditor))).sequenceNumber;
  await submitMessage(client, taskTopicId, buildTaskReviewed(skill, auditor, rating, comment, reviewTopicId, votingTopicId));

  // 3) mint a VERIFIED HTS NFT — only for an APPROVED, SAFE skill
  let mint: FinalizeResult["mint"];
  if (approve && verdict === "SAFE") {
    const st = loadState();
    let tokenId = st.verifiedTokenId;
    if (!tokenId) { tokenId = (await createVerifiedCollection(client)).tokenId; saveState({ verifiedTokenId: tokenId }); }
    let metadata = JSON.stringify({ skill, verdict, task: taskTopicId });
    if (Buffer.byteLength(metadata, "utf-8") > 100) metadata = JSON.stringify({ skill: skill.slice(0, 22), task: taskTopicId });
    const minted = await mintNft(client, tokenId, metadata);
    let transferred = false;
    if (mintToAccountId) { try { await transferNft(client, tokenId, Number(minted.serial), mintToAccountId); transferred = true; } catch { /* keep in treasury */ } }
    const owner = transferred && mintToAccountId ? mintToAccountId : getOperatorId();
    await submitMessage(client, taskTopicId, buildTaskMinted(skill, tokenId, minted.serial, owner, metadata));
    mint = { tokenId, serial: minted.serial, metadata, owner, transferred };
  }

  // 4) update the main registry (status + mint pointer) → the dashboard's verified-skills list
  if (registryTopicId) {
    const status = approve ? (verdict === "SAFE" ? "verified" : "approved") : "rejected";
    await submitMessage(client, registryTopicId, buildJobUpdated({ jobId: taskTopicId, status, verdict, note: mint ? `HTS ${mint.tokenId}#${mint.serial}` : decision }));
  }

  return { decision, rating, comment, reviewSeq, voteSeq, mint };
}

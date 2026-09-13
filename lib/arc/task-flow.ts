// lib/arc/task-flow.ts — the ONE shared ethonlineArc task flow. This is the single source of
// truth, called by BOTH entrypoints so they behave identically:
//   • the CLI     → scripts/arc/run-task.ts   (npx tsx scripts/arc/run-task.ts <skill> [agent])
//   • the curl API → pages/api/arc/run-task.ts (curl -N ".../api/arc/run-task?agent_id=…&skill=…")
//
// Given an agent_id (the requester) and a skill reference (local path | demo name |
// npm package | github raw url), runTaskFlow() runs the entire lifecycle end-to-end:
//
//   STEP 1  create + post the task        — open the per-task HCS topic FIRST (init, status
//                                           "posted" = not started) + registry job_posted("open")
//   STEP 2  negotiate                      — HCS-16 room (ask → AI quote → accept), after posting
//   STEP 3  lock the escrow (both sides)   — Arc ethonlineArc: developer fee + auditor bond (0.1/0.1);
//                                           only then does Hedera advance: escrow_funded + funded
//   STEP 4  run the auditing procedure     — the REAL pipeline: 4 OpenAI stages (scanner →
//                                           sandbox → fork → synthesizer) + a Phala TDX
//                                           attestation; every stage + verdict posted to HCS
//   STEP 5  add to db + /skills + whitelist — on SAFE: save the versioned skill, register it,
//                                           and add the requester to licensed_agents
//   STEP 6  requester decision + mint NFT   — approve (SAFE) / block (DANGEROUS); review the
//                                           auditor; mint a VERIFIED HTS NFT to the requester
//   STEP 7  rate + comment the auditor      — AI comment (gpt-4.1-nano) → HCS + the DB
//   STEP 8  settle or slash the escrow      — approve → release (fee+bond → auditor); disapprove →
//                                           slash (bond → reporter, fee refunded → developer)
//
// WHERE THINGS ARE STORED
//   HCS  · negotiation room (HCS-16)        — the 3 chat lines
//        · per-task topic (id == auditId)   — init(posted) → escrow_funded → stages → verdict →
//                                             decision → reviewed → minted → escrow_resolved
//        · main registry                    — job_posted(open) → job_updated(funded → verified/rejected)
//        · HCS-1 file                        — the skill source when > 1000 bytes (hcs://1/<id>)
//        · auditor review + voting topics    — the rating, AI comment, and a "good" reputation vote
//        · HTS                               — the VERIFIED NFT collection + minted serial
//   DB   · db/audits.json   — the audit record (synthesizer verdict + the full TDX quote)
//        · db/attest.json   — the same attestation, keyed by audit_id (served by /api/attest)
//        · db/skills.json   — verified-skill registry; licensed_agents[] is the whitelist
//        · skills/<name>-v<N>/ — the actual saved skill files on disk
//        · db/auditors.json — the auditor profile: reviews[] + aggregate rating
//        · db/users.json    — the user record: reviews_given[]
//
// Output is streamed line-by-line through the caller-supplied `write(line)` sink, so the
// CLI can colour it (color:true) and the endpoint can pipe plain text to `curl`
// (color:false). The structured TaskFlowResult is returned for programmatic callers.
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import {
  getClient, getOperatorKey, getOperatorId, hashscan,
  createTopic, submitMessage,
  hcs16Memo, buildHCS16FloraCreated, buildHCS16Chat,
  buildTaskInit, buildAuditStage, buildAuditVerdictFull, buildJobPosted, buildJobUpdated,
  buildEscrowFunded, buildEscrowResolved,
  uploadFileHCS1,
} from "../hederaone/hedera";
// Arc payment leg: lock both sides into ethonlineArc once agreed, then settle (approve) or slash
// (disapprove) after the audit. Fail-soft — if the Arc keys/funds aren't there the flow carries on.
import { openAndFundEscrow, resolveEscrow, slashEscrow, escrowConfigured, escrowAmounts, escrowAccounts, ESCROW_ADDRESS, explorerTx } from "./escrow-server";
import { loadState, saveState } from "../hederaone/state";
import { initMars } from "../hederaone/agents";
import { REQUESTER, AUDITOR, AUDITOR_REVIEW_TOPIC, AUDITOR_VOTING_TOPIC, requesterAsk, requesterAccept, SKILL_DESCRIPTIONS, type DemoSkill } from "../hederaone/demo-skills";
import { generateAuditorQuote, generateReviewComment } from "../hederaone/auditor";
import { resolveRemoteSkill, resolveLocalDemoSkill, readLocalSkill } from "../hederaone/skill-source.mjs";
import { runAuditPipeline, DEFAULT_MODEL } from "../hederaone/audit-core.mjs";
import { startAudit, setAuditStage, appendEvidence, finishAudit, saveVerifiedSkill, saveAttestation, saveAuditorReview } from "../hederaone/db.mjs";
// post-audit lifecycle (from the cedric/jy branch): requester decision → review the
// auditor → mint a VERIFIED HTS NFT to the requester, all recorded on the task topic.
import { finalizeTaskToHcs } from "../hederaone/audit-task";

// ── ANSI palette (stripped to empty strings when color:false, e.g. for the endpoint) ──
const ANSI = { dim: "\x1b[2m", reset: "\x1b[0m", bold: "\x1b[1m", blue: "\x1b[34m", purple: "\x1b[35m", green: "\x1b[32m", red: "\x1b[31m", amber: "\x1b[33m", cyan: "\x1b[36m" };
const PLAIN = { dim: "", reset: "", bold: "", blue: "", purple: "", green: "", red: "", amber: "", cyan: "" };

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms)); // pace the chat bubbles
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);   // "scanner" → "Scanner"
// Map a pipeline stage to the audit record's stage number (1-3); the synthesizer is stage 4.
const STAGE_NUM: Record<string, number> = { scanner: 1, sandbox: 2, fork: 3 };
// Turn the synthesizer's risk band into a 0-100 trust score for the on-chain verdict.
const TRUST: Record<string, number> = { none: 98, low: 90, medium: 58, high: 16, critical: 4 };

export interface TaskFlowOptions {
  agentId?: string;                 // requester account — whitelisted on a SAFE verdict (defaults to demo REQUESTER)
  skillRef: string;                 // local path | demo name | npm package | github/url
  model?: string;                   // OpenAI model (defaults to OPENAI_MODEL or gpt-4o-mini)
  color?: boolean;                  // ANSI colour in the streamed output (default true)
  write?: (line: string) => void;   // output sink — one line at a time (default: no-op)
}

export interface TaskFlowResult {
  skill: string;
  requester: string;
  auditId: string;
  taskTopicId: string;
  chatRoomTopicId: string;
  verdict: "SAFE" | "DANGEROUS";
  risk: string;
  trust: number;
  safe: boolean;
  licensed: boolean;
  verified: { verified_name: string; version: number; path: string } | null;
  attested: boolean;
  decision: "approved" | "disapproved";
  mint: { tokenId: string; serial: string; owner: string } | null;
  review: { auditor: string; rating: number; comment: string; source: "openai" | "fallback"; auditorAvgRating: string };
  // Arc escrow leg (null when not configured / skipped). funded = both sides locked on agreement;
  // resolved = settled (approve → fee+bond to auditor) or slashed (disapprove → bond to reporter).
  escrow: {
    jobId: number; developer: string; auditor: string; fee: string; bond: string;
    funded: boolean; resolved: boolean; outcome: "settled" | "slashed" | null;
    createTx?: string; fundFeeTx?: string; postBondTx?: string; resolveTx?: string;
    paidTo?: string; amount?: string; feeRefunded?: string; status: string;
  } | null;
  hashscanTask: string;
}

/** Resolve any package into { name, files } — local file/dir, demo skill, npm package, or URL. */
async function resolveSkill(arg: string): Promise<{ name: string; files: { name: string; content: string }[] }> {
  if (existsSync(arg)) return readLocalSkill(arg);
  const demo = resolveLocalDemoSkill(arg);
  if (demo) return demo;
  return resolveRemoteSkill(arg);
}

/** The one global HCS-16 chat room (same as the /api/hederaone/hedera ensureChatRoom action). */
async function ensureChatRoom(client: ReturnType<typeof getClient>): Promise<string> {
  const st = loadState();
  if (st.chatRoomTopicId) return st.chatRoomTopicId;
  const floraId = "ethonlineArc-chatroom";
  const communication = await createTopic(client, hcs16Memo(floraId, 0), getOperatorKey().publicKey);
  await submitMessage(client, communication, buildHCS16FloraCreated(getOperatorId(), communication, communication, communication, "ethonlineArc negotiation room"));
  saveState({ chatRoomTopicId: communication, chatFloraId: floraId });
  return communication;
}

/**
 * Run the full audit-and-license flow for one package the agent wants to use.
 * Opens (and always closes) its own Hedera client. Throws if OPENAI_API_KEY is unset.
 */
export async function runTaskFlow(opts: TaskFlowOptions): Promise<TaskFlowResult> {
  const C = opts.color === false ? PLAIN : ANSI;        // colour palette (or no-op for curl)
  const w = opts.write ?? (() => {});                   // line sink (console.log / res.write)
  const requester = opts.agentId || REQUESTER;          // the agent that gets licensed on SAFE
  const model = opts.model || process.env.OPENAI_MODEL || DEFAULT_MODEL; // audit model (gpt-4o-mini)

  // The audit is real — there's no fake path. Fail fast if the key is missing.
  if (!process.env.OPENAI_API_KEY) throw new Error("OPENAI_API_KEY is required — the auditor runs the real pipeline.");

  // Fetch the package to audit → { name, files[] } (local file/dir, demo, npm, or url).
  const { name, files } = await resolveSkill(opts.skillRef);
  // a lightweight descriptor purely for the negotiation lines (scope is what we're about to find out)
  const desc: DemoSkill = {
    ref: opts.skillRef, name, version: "—", scope: "declared vs actual behaviour (network · files · wallet · secrets)",
    tier: "automated", compliance: "FIN", price: "1 USDC", bond: "2,500 USDC", time: "~10m",
    expect: "SAFE", trust: 0, steps: [],
  };

  const client = getClient();
  try {
    const registryTopicId = loadState().registryTopicId ?? (await initMars(client)).registryTopicId;

    // ════════════════════════════════════════════════════════════════════════
    // STEP 1 — CREATE + POST THE TASK  (Hedera task topic FIRST, status "posted" = NOT started)
    // ════════════════════════════════════════════════════════════════════════
    // The requester posts a skill for audit. We open the per-task HCS topic right away with an init
    // manifest (status "posted") so the task is visible on-chain BEFORE any negotiation — it exists
    // but hasn't started. The skill source rides inline, or on HCS-1 when it's > 1KB.
    const chatRoomTopicId = await ensureChatRoom(client);
    const source = files.map((f) => `=== ${f.name} ===\n${f.content}`).join("\n").slice(0, 8000);
    const contentHash = createHash("sha256").update(source).digest("hex");
    const terms = {
      // WHO/WHAT manifest: payer (added by buildTaskInit) + auditor + skill + declared description
      // + the files submitted + scope + the asking terms. status "posted" = awaiting negotiation.
      skill: name, description: SKILL_DESCRIPTIONS[opts.skillRef], files: files.map((f) => f.name),
      scope: desc.scope, requester, auditor: AUDITOR,
      price: desc.price, bond: desc.bond, time: desc.time, version: desc.version,
      tier: desc.tier, compliance: desc.compliance, contentHash, chatRoomTopicId,
    };
    let content = source;
    let contentHrl: string | undefined;
    if (Buffer.byteLength(buildTaskInit({ ...terms, content: source, status: "posted" }), "utf-8") > 1000) {
      const file = await uploadFileHCS1(client, source, "application/octet-stream");
      content = file.hrl;
      contentHrl = file.hrl;
    }
    const taskTopicId = await createTopic(client, `ethonlineArc-task:${name}`, getOperatorKey().publicKey);
    const initSeq = (await submitMessage(client, taskTopicId, buildTaskInit({ ...terms, content, contentHrl, status: "posted" }))).sequenceNumber;
    await submitMessage(client, registryTopicId, buildJobPosted({ jobId: taskTopicId, skill: name, requester, scope: desc.scope, auditTrailTopicId: taskTopicId, status: "posted" }));
    w(`\n${C.bold}TASK POSTED${C.reset}  ${hashscan("topic", taskTopicId)}  ${C.dim}status: posted (not started)${C.reset}`);
    w(`  ${C.green}⛓ seq ${initSeq}${C.reset}  init · skill ${name} · requester ${requester}${contentHrl ? ` · content ${contentHrl}` : ""}\n`);

    // ════════════════════════════════════════════════════════════════════════
    // STEP 2 — NEGOTIATE  (the talk happens AFTER the task is posted)
    // ════════════════════════════════════════════════════════════════════════
    w(`${C.amber}${C.bold}NEGOTIATION ROOM${C.reset}  ${C.dim}HCS-16${C.reset}  ${hashscan("topic", chatRoomTopicId)}\n`);
    // ── negotiation — real HCS messages; only the auditor's quote is AI-generated ──
    const postTurn = async (from: string, text: string, tag = "") => {
      const r = await submitMessage(client, chatRoomTopicId, buildHCS16Chat(from, loadState().chatFloraId ?? "ethonlineArc-chatroom", text));
      const role = from === AUDITOR ? `${C.purple}auditor${C.reset}` : `${C.blue}requester${C.reset}`;
      w(`  ${role} ${C.dim}${from}${C.reset}   ${C.green}⛓ seq ${r.sequenceNumber}${C.reset}${tag}`);
      w(`    ${text}\n`);
      await sleep(600);
    };
    await postTurn(requester, requesterAsk(desc));
    const quote = await generateAuditorQuote(desc, requesterAsk(desc));
    await postTurn(AUDITOR, quote.text, `  ${C.dim}(${quote.source})${C.reset}`);
    await postTurn(requester, requesterAccept());

    // ════════════════════════════════════════════════════════════════════════
    // STEP 3 — AGREED → LOCK BOTH SIDES INTO THE ARC ESCROW, then Hedera advances (task STARTS)
    // ════════════════════════════════════════════════════════════════════════
    // Both parties lock USDC into ethonlineArc on Arc (developer funds the FEE, auditor posts the BOND
    // — 0.1 / 0.1 demo). The two sides are two Arc EOAs: developer = ARC_PRIVATE_KEY (or
    // ARC_DEVELOPER_KEY), auditor = SELLER_PRIVATE_KEY (falls back to one key if unset) — see
    // lib/arc/escrow-server.ts. ONLY once the money is in does the Hedera task move to its next state:
    // an `escrow_funded` receipt on the task topic + a registry job_updated → "funded" (= started).
    // Fail-soft: no Arc keys/funds → log + skip; the audit + Hedera + NFT never depend on it.
    let escrow: TaskFlowResult["escrow"] = null;
    if (escrowConfigured()) {
      const amt = escrowAmounts();
      w(`${C.bold}ARC ESCROW${C.reset}  ${C.dim}both sides lock USDC · fee ${amt.fee} · bond ${amt.bond}${C.reset}`);
      try {
        const f = await openAndFundEscrow();
        await submitMessage(client, taskTopicId, buildEscrowFunded(name, {
          jobId: f.jobId, escrow: ESCROW_ADDRESS, developer: f.developer, auditor: f.auditor,
          fee: f.fee, bond: f.bond, status: f.status, createTx: f.createTx, fundFeeTx: f.fundFeeTx, postBondTx: f.postBondTx,
        }));
        // Hedera goes to the next move only now that the money is in: registry posted → funded.
        await submitMessage(client, registryTopicId, buildJobUpdated({ jobId: taskTopicId, status: "funded", note: `escrow ${f.fee}+${f.bond} USDC locked` }));
        escrow = { jobId: f.jobId, developer: f.developer, auditor: f.auditor, fee: f.fee, bond: f.bond, funded: true, resolved: false, outcome: null, createTx: f.createTx, fundFeeTx: f.fundFeeTx, postBondTx: f.postBondTx, status: f.status };
        w(`  ${C.green}✓ job #${f.jobId} ${f.status}${C.reset}  ${C.dim}developer ${f.developer.slice(0, 10)}… locked fee ${f.fee} · auditor ${f.auditor.slice(0, 10)}… posted bond ${f.bond}${C.reset}`);
        w(`  ${C.dim}fee  ↗ ${explorerTx(f.fundFeeTx)}${C.reset}`);
        w(`  ${C.dim}bond ↗ ${explorerTx(f.postBondTx)}${C.reset}`);
        w(`  ${C.green}→ task STARTED${C.reset} ${C.dim}(Hedera advanced: posted → funded)${C.reset}\n`);
      } catch (e) {
        w(`  ${C.amber}! escrow skipped: ${e instanceof Error ? e.message : "escrow failed"}${C.reset}\n`);
      }
    } else {
      w(`${C.dim}ARC ESCROW: not configured (set ARC_PRIVATE_KEY + ARC_DEVELOPER_KEY) — skipping the payment leg${C.reset}\n`);
    }

    // ════════════════════════════════════════════════════════════════════════
    // STEP 4 — RUN THE AUDITING PROCEDURE (the REAL pipeline, OpenAI per stage)
    // ════════════════════════════════════════════════════════════════════════
    // The audit id IS the on-chain job id: the HCS task topic created above (the same id
    // used as job_posted's jobId + auditTrailTopicId). So audits.json keys directly to the
    // replayable HCS trail — no separate random id.
    const auditId = taskTopicId;
    startAudit({ auditId, skill: name, agentId: requester, auditor: AUDITOR, model, files: files.map((f) => f.name), chatRoom: chatRoomTopicId });
    // NOTE: `model` is kept ONLY internally (the OpenAI call + the off-chain audits.json log).
    // It is deliberately NOT shown to the user and NOT written to HCS — the on-chain record is
    // model-agnostic (the verdict + evidence stand on their own, regardless of which LLM produced them).
    w(`${C.cyan}${C.bold}AUDIT${C.reset}  ${C.dim}${auditId}${C.reset}`);

    // runAuditPipeline does the 4 OpenAI stages + the Phala attestation. We don't just wait
    // for the result — the onEvent callback fires per stage so we can (a) stream live progress
    // to the caller and (b) mirror each stage into db/audits.json as it happens, which is what
    // makes the dashboard's "live audits" panel update in real time.
    const result = await runAuditPipeline({
      name, files, auditId, model,
      apiKey: process.env.OPENAI_API_KEY,
      attestorUrl: process.env.PHALA_ATTESTOR_URL, // unset → attestation skipped (verdict still stands)
      onEvent: (e: {
        type?: string; stage?: string; name?: string; status?: string;
        summary?: string; findings?: { severity: string }[]; error?: string;
        attestation?: { mocked?: boolean; reportData?: string; verify?: string };
      }) => {
        if (e.type === "stage" && e.status === "running") {
          if (STAGE_NUM[e.stage ?? ""]) setAuditStage(auditId, STAGE_NUM[e.stage ?? ""], e.name);
          w(`  ${C.cyan}▶ ${e.name}${C.reset} ${C.dim}…${C.reset}`);
        } else if (e.type === "stage" && e.status === "done") {
          appendEvidence(auditId, { stage: e.stage, summary: e.summary, findings: e.findings });
          w(`  ${C.green}✓${C.reset} ${e.summary || ""}`);
        } else if (e.type === "synth" && e.status === "running") {
          setAuditStage(auditId, 4, "Synthesizer");
          w(`  ${C.cyan}▶ Synthesizer${C.reset} ${C.dim}— evidence → attested verdict …${C.reset}`);
        } else if (e.type === "synth" && e.status === "done") {
          w(`  ${C.green}✓${C.reset} verdict produced`);
        } else if (e.type === "attest" && e.status === "running") {
          w(`  ${C.cyan}▶ TEE attestation${C.reset} ${C.dim}— sealing record in Phala enclave …${C.reset}`);
        } else if (e.type === "attest" && e.status === "done") {
          const badge = e.attestation?.mocked ? `${C.amber}MOCK (no CVM)${C.reset}` : `${C.green}attested ✓${C.reset}`;
          w(`  ${C.green}✓${C.reset} ${badge}  reportData 0x${String(e.attestation?.reportData).slice(0, 20)}…`);
          w(`    ${C.dim}verify: ${e.attestation?.verify || "https://proof.t16z.com/"}${C.reset}`);
        } else if (e.type === "attest" && e.status === "error") {
          w(`  ${C.amber}! TEE attestation skipped: ${e.error}${C.reset}`);
        }
      },
    });

    const verdict = result.verdict;                 // synthesizer output (verdict/risk/summary/caps/…)
    const fileSha256 = result.record.file_sha256;   // hash of the audited bytes (bound into the attestation)
    const trust = TRUST[String(verdict.risk).toLowerCase()] ?? (result.safe ? 90 : 6);

    // ── post each REAL stage + the verdict to the task topic (the on-chain audit trail) ──
    // The pipeline already ran; here we write the evidence to HCS in order so the task topic is
    // a complete, replayable record. A stage with a high/critical finding is marked "fail".
    w(`\n  ${C.dim}posting audit trail → task topic${C.reset}`);
    for (const ev of result.record.evidence as { stage: string; summary?: string; findings?: { severity: string; title: string; detail?: string }[] }[]) {
      const findings = ev.findings ?? [];
      const status = findings.some((f) => ["high", "critical"].includes(String(f.severity).toLowerCase())) ? "fail" : "pass";
      // RICH stage record: summary + each finding (severity/title/detail) + a severity histogram.
      // model is intentionally omitted — the on-chain trail stays model-agnostic.
      const r = await submitMessage(client, taskTopicId, buildAuditStage(name, cap(ev.stage), ev.summary || "", findings));
      const mark = status === "fail" ? `${C.red}✗${C.reset}` : `${C.green}✓${C.reset}`;
      w(`  ${mark} ${C.bold}${cap(ev.stage).padEnd(12)}${C.reset} ${C.dim}seq ${r.sequenceNumber}${C.reset}  ${ev.summary || ""}`);
    }
    // the FULL untruncated report (all evidence + the synthesizer verdict + the TDX attestation) → HCS-1,
    // content-addressed; the on-chain verdict references it by HRL.
    const reportFile = await uploadFileHCS1(client, JSON.stringify({ ...result.record, verdict, attestation: result.attestation ?? null }), "application/json");
    const attHex = result.attestation?.reportData && !result.attestation?.error ? `0x${String(result.attestation.reportData).replace(/^0x/, "").slice(0, 48)}` : undefined;
    // RICH verdict: capabilities ("what it actually does") + risk + recommendation + the HCS-1 report (+ attestation).
    // model is intentionally omitted — the on-chain verdict stays model-agnostic.
    const vSeq = (await submitMessage(client, taskTopicId, buildAuditVerdictFull(name, {
      verdict: verdict.verdict, risk: verdict.risk, summary: verdict.summary,
      capabilities: verdict.capabilities, recommendation: verdict.recommendation,
      trustScore: trust, reportHrl: reportFile.hrl, attestation: attHex,
    }))).sequenceNumber;

    // ════════════════════════════════════════════════════════════════════════
    // STEP 5 — ADD TO DB + /skills + WHITELIST the agent_id
    // ════════════════════════════════════════════════════════════════════════
    // On SAFE: write the versioned skill to /skills, register it in db/skills.json,
    // and add the requester to that skill's licensed_agents (the whitelist). DANGEROUS → skip.
    let verified: { verified_name: string; version: number; path: string } | null = null;
    if (result.safe) {
      verified = saveVerifiedSkill({ skill: name, files, agentId: requester, auditId, fileSha256 });
    }
    // finishAudit flips the record to "audited" and stores the synthesizer verdict + the FULL
    // TDX quote into db/audits.json; saveAttestation also keeps it in db/attest.json (for /api/attest).
    finishAudit(auditId, { verdict: verdict.verdict, risk: verdict.risk, fileSha256, verified, attestation: result.attestation, steps: result.record.evidence, verdictFull: verdict });
    if (result.attestation) saveAttestation(auditId, result.attestation, { skill: name, verdict: verdict.verdict, agent_id: requester });

    // ════════════════════════════════════════════════════════════════════════
    // STEP 6 — requester DECISION → review the auditor → mint a VERIFIED HTS NFT
    // ════════════════════════════════════════════════════════════════════════
    // A skill is VERIFIED only on the requester's approval (SAFE → approve + mint;
    // DANGEROUS → block). finalizeTaskToHcs records the decision + auditor review on
    // the task topic, rates the auditor on its own review/voting HCS, mints a VERIFIED
    // HTS NFT to the requester on SAFE, and updates the main registry (verified/rejected).
    const approve = result.safe;
    const rating = 5; // the auditor did its job in both cases (clean verdict / caught the threat)
    const review = await generateReviewComment({ skill: name, verdict: verdict.verdict, rating, auditor: AUDITOR });
    const fin = await finalizeTaskToHcs(client, {
      taskTopicId, skill: name, verdict: verdict.verdict, approve, rating, comment: review.comment,
      requester, auditor: AUDITOR,
      reviewTopicId: AUDITOR_REVIEW_TOPIC, votingTopicId: AUDITOR_VOTING_TOPIC,
      registryTopicId, mintToAccountId: requester,
    });

    // ════════════════════════════════════════════════════════════════════════
    // STEP 7 — the user-agent's rating + AI comment → recorded on HCS (above) + DB
    // ════════════════════════════════════════════════════════════════════════
    // finalizeTaskToHcs already wrote the review to the auditor's review + voting HCS
    // topics; here we persist the same rating + comment into the DB: the comment lives
    // in the AUDITOR's profile (auditors.json) and on the USER's record (users.json).
    const savedReview = saveAuditorReview({
      auditorId: AUDITOR, reviewerId: requester, rating: fin.rating, comment: fin.comment,
      skill: name, verdict: verdict.verdict, reviewSeq: fin.reviewSeq, voteSeq: fin.voteSeq, taskTopicId,
    });

    // ════════════════════════════════════════════════════════════════════════
    // STEP 8 — DONE → SETTLE or SLASH THE ARC ESCROW (based on the requester's decision)
    // ════════════════════════════════════════════════════════════════════════
    // The audit is finished and the decision is recorded, so resolve the payment leg:
    //   • APPROVE (SAFE)      → SETTLE: release(jobId) pays fee + bond → auditor (Funded → Settled)
    //   • DISAPPROVE (DANGER) → SLASH:  slash(jobId, reporter) sends the bond → the auditor that
    //                                   caught it, and refunds the fee → the developer (→ Slashed)
    // The task topic gets an `escrow_resolved` receipt either way. Fail-soft; only runs if funded.
    if (escrow?.funded) {
      try {
        const r = approve
          ? await resolveEscrow(escrow.jobId)
          : await slashEscrow(escrow.jobId, escrowAccounts().auditor);
        await submitMessage(client, taskTopicId, buildEscrowResolved(name, {
          jobId: r.jobId, outcome: r.outcome, tx: r.tx, paidTo: r.paidTo, amount: r.amount, feeRefunded: r.feeRefunded, status: r.status,
        }));
        escrow = { ...escrow, resolved: true, outcome: r.outcome, resolveTx: r.tx, paidTo: r.paidTo, amount: r.amount, feeRefunded: r.feeRefunded, status: r.status };
      } catch (e) {
        w(`  ${C.amber}! escrow ${approve ? "settle" : "slash"} skipped: ${e instanceof Error ? e.message : "resolve failed"}${C.reset}`);
      }
    }

    // ── FINAL — the two closing steps, mirrored from pages/audit.tsx:
    //   (a) Synthesizer verdict (summary · capabilities · recommendation)
    //   (b) TEE attestation quote (Phala TDX)
    const vColor = result.safe ? C.green : C.red;
    w(`\n  ${vColor}${C.bold}VERDICT: ${verdict.verdict}${C.reset}  trust ${trust}  ${C.dim}risk ${verdict.risk} · seq ${vSeq}${C.reset}`);
    if (verdict.summary) w(`  ${verdict.summary}`);
    if (Array.isArray(verdict.capabilities) && verdict.capabilities.length) {
      w(`  ${C.dim}capabilities (what it actually does):${C.reset}`);
      for (const c of verdict.capabilities) w(`    ${C.dim}•${C.reset} ${c}`);
    }
    if (verdict.recommendation) w(`  ${C.bold}recommendation:${C.reset} ${verdict.recommendation}`);

    // license result
    if (result.safe && verified) {
      w(`\n  ${C.green}✓ verified${C.reset}  ${verified.verified_name}  →  ${C.bold}licensed to ${requester}${C.reset}`);
      w(`  ${C.dim}saved → ${verified.path} · db/skills.json licensed_agents += ${requester}${C.reset}`);
    } else {
      w(`\n  ${C.red}✗ flagged ${verdict.verdict}${C.reset}  — not verified, not licensed`);
    }

    // STEP 6 + 7 result — requester decision, auditor review/rating + AI comment, VERIFIED NFT
    w(`\n  ${approve ? C.green + "APPROVED" : C.red + "BLOCKED"}${C.reset}  ${C.dim}requester ${fin.decision}${C.reset}`);
    w(`  ${C.dim}auditor reviewed${C.reset} ${C.amber}${"★".repeat(fin.rating)}${C.reset} ${C.dim}(${AUDITOR} → avg ${savedReview.rating} over ${savedReview.review_count})${C.reset}`);
    w(`  ${C.dim}comment (${review.source}):${C.reset} "${fin.comment}"`);
    w(`  ${C.dim}saved → auditors.json[${AUDITOR}].reviews · users.json[${requester}].reviews_given · HCS review/voting${C.reset}`);
    if (fin.mint) w(`  ${C.green}✓ VERIFIED NFT${C.reset}  ${hashscan("token", fin.mint.tokenId)} ${C.dim}#${fin.mint.serial} → ${fin.mint.owner}${C.reset}`);

    // Arc escrow resolution — the money leg, alongside the verdict + NFT (settle or slash)
    if (escrow?.resolved && escrow.outcome === "settled") w(`\n  ${C.green}✓ ESCROW SETTLED${C.reset}  ${C.dim}Arc job #${escrow.jobId} · ${escrow.amount} USDC (fee+bond) → auditor · ${explorerTx(escrow.resolveTx!)}${C.reset}`);
    else if (escrow?.resolved && escrow.outcome === "slashed") w(`\n  ${C.red}⛓ ESCROW SLASHED${C.reset}  ${C.dim}Arc job #${escrow.jobId} · bond ${escrow.amount} USDC → auditor (caught it) · fee ${escrow.feeRefunded} refunded → developer · ${explorerTx(escrow.resolveTx!)}${C.reset}`);
    else if (escrow?.funded) w(`\n  ${C.amber}escrow funded but not resolved${C.reset}  ${C.dim}Arc job #${escrow.jobId}${C.reset}`);

    // TEE attestation quote — the sealed proof the audit ran in the enclave
    const att = result.attestation;
    const attested = !!(att && !att.error);
    if (attested) {
      const badge = att.mocked ? `${C.amber}MOCK · no CVM${C.reset}` : `${C.green}Attested ✓${C.reset}`;
      w(`\n  ${C.bold}TEE ATTESTATION · Phala TDX${C.reset}  ${badge}`);
      w(`  ${C.dim}reportData (sha256 of audit record)${C.reset}  0x${String(att.reportData).slice(0, 24)}…`);
      if (att.info?.app_id) w(`  ${C.dim}enclave app id${C.reset}  ${att.info.app_id}`);
      w(`  ${C.dim}verify ↗${C.reset}  ${att.verify || "https://proof.t16z.com/"}`);
      if (att.quote) {
        // Print the FULL quote on its own ANSI-free line so it can be selected
        // (triple-click) and pasted straight into the TEE explorer.
        w(`  ${C.dim}TDX quote (${String(att.quote).length} chars) — select the line below and paste into the explorer:${C.reset}`);
        w(String(att.quote));
      }
    } else if (att?.error) {
      w(`\n  ${C.amber}TEE attestation unavailable${C.reset} — ${att.error}`);
    } else {
      w(`\n  ${C.dim}TEE attestation: not requested (set PHALA_ATTESTOR_URL)${C.reset}`);
    }

    w(`\n${C.dim}full trail → ${hashscan("topic", taskTopicId)}${C.reset}\n`);

    return {
      skill: name, requester, auditId, taskTopicId, chatRoomTopicId,
      verdict: verdict.verdict, risk: verdict.risk, trust, safe: result.safe,
      licensed: !!(result.safe && verified), verified, attested,
      decision: fin.decision,
      mint: fin.mint ? { tokenId: fin.mint.tokenId, serial: fin.mint.serial, owner: fin.mint.owner } : null,
      review: { auditor: AUDITOR, rating: fin.rating, comment: fin.comment, source: review.source, auditorAvgRating: savedReview.rating },
      escrow,
      hashscanTask: hashscan("topic", taskTopicId),
    };
  } finally {
    client.close();
  }
}

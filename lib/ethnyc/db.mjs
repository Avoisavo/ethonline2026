// Tiny JSON "database" for the audit flow.
//   db/audits.json  — one record per audit (status: auditing → audited)
//   db/skills.json  — registry of VERIFIED skills + which agents may use them
// Verified skill files are copied to  skills/<name>-v<N>/  on a SAFE verdict.
//
// Note: requires a writable filesystem (a VPS / self-hosted Node server).
// On a read-only host (e.g. Vercel) point DB_DIR/SKILLS_DIR at /tmp.

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

const ROOT = process.cwd();
const DB_DIR = join(ROOT, "db");
const SKILLS_DIR = join(ROOT, "skills");
const AUDITS = join(DB_DIR, "audits.json");
const REGISTRY = join(DB_DIR, "skills.json");
const ATTEST = join(DB_DIR, "attest.json");
const USERS = join(DB_DIR, "users.json");
const AUDITORS = join(DB_DIR, "auditors.json");
const SESSION = join(DB_DIR, "session.json");

const now = () => new Date().toISOString();

function readJSON(p, fallback) {
  try {
    return JSON.parse(readFileSync(p, "utf8"));
  } catch {
    return fallback;
  }
}
function writeJSON(p, data) {
  mkdirSync(DB_DIR, { recursive: true });
  writeFileSync(p, JSON.stringify(data, null, 2));
}
function sanitize(s) {
  return (
    String(s || "")
      .replace(/^@/, "")
      .replace(/[^A-Za-z0-9._-]+/g, "-")
      .replace(/^-+|-+$/g, "")
      .slice(0, 80) || "skill"
  );
}
function safeRel(p) {
  // strip leading slashes and any ".." so saved paths stay inside the skill dir
  return String(p).replace(/^[/\\]+/, "").split(/[/\\]+/).filter((s) => s && s !== "..").join("/");
}

// ── status tracking ─────────────────────────────────────────────────────────
export function startAudit({ auditId, skill, agentId, auditor, model, files, chatRoom }) {
  const db = readJSON(AUDITS, {});
  db[auditId] = {
    audit_id: auditId, // == the HCS task-trail topic id (0.0.x)
    skill,
    agent_id: agentId || "anonymous", // the requester that wants the skill
    auditor: auditor || null, // the auditor agent that ran it (distinct from the requester)
    chat_room: chatRoom || null, // the HCS-16 negotiation room id
    model,
    files: files || [],
    status: "auditing",
    verdict: null,
    started_at: now(),
    completed_at: null,
  };
  writeJSON(AUDITS, db);
  return db[auditId];
}

// Advance the in-flight stage: status becomes "auditing-1".."auditing-4".
export function setAuditStage(auditId, stage, stageName) {
  const db = readJSON(AUDITS, {});
  const rec = db[auditId];
  if (!rec) return;
  rec.status = `auditing-${stage}`;
  rec.stage = stage;
  rec.stage_name = stageName;
  rec.updated_at = now();
  db[auditId] = rec;
  writeJSON(AUDITS, db);
}

// Record a finished stage's real output as it completes (live per-stage detail).
export function appendEvidence(auditId, entry) {
  const db = readJSON(AUDITS, {});
  const rec = db[auditId];
  if (!rec) return;
  rec.evidence = Array.isArray(rec.evidence) ? rec.evidence : [];
  rec.evidence.push({ stage: entry.stage, description: "", summary: entry.summary || "", findings: entry.findings || [] });
  rec.updated_at = now();
  db[auditId] = rec;
  writeJSON(AUDITS, db);
}

// Most-recent audits first — for the Live Audits feed.
export function listAudits(limit = 20) {
  const db = readJSON(AUDITS, {});
  return Object.values(db)
    .sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")))
    .slice(0, limit);
}

export function finishAudit(auditId, { verdict, risk, fileSha256, verified, attestation, steps, verdictFull }) {
  const db = readJSON(AUDITS, {});
  const rec = db[auditId] || { audit_id: auditId };
  rec.status = "audited";
  rec.stage = 4;
  rec.stage_name = "done";
  rec.verdict = verdict ?? null;
  rec.risk = risk ?? null;
  rec.file_sha256 = fileSha256 ?? null;
  rec.evidence = steps ?? rec.evidence ?? [];
  rec.summary = verdictFull?.summary ?? null;
  rec.capabilities = verdictFull?.capabilities ?? [];
  rec.findings = verdictFull?.findings ?? [];
  rec.recommendation = verdictFull?.recommendation ?? null;
  rec.verified_name = verified?.verified_name ?? null;
  rec.version = verified?.version ?? null;
  rec.saved_path = verified?.path ?? null;
  rec.attestation_reportData = attestation?.reportData ?? null;
  rec.attestation_mocked = attestation ? !!attestation.mocked : null;
  // Full TEE attestation (incl. the TDX quote) embedded in the audit record itself,
  // so audits.json is self-contained (the same data also lives in db/attest.json).
  rec.attestation = attestation
    ? {
        reportData: attestation.reportData ?? null,
        mocked: !!attestation.mocked,
        quote: attestation.quote ?? null,
        event_log: attestation.event_log ?? null,
        vm_config: attestation.vm_config ?? null,
        info: attestation.info ?? null,
        verify: attestation.verify ?? "https://proof.t16z.com/",
        error: attestation.error ?? null,
      }
    : null;
  rec.completed_at = now();
  db[auditId] = rec;
  writeJSON(AUDITS, db);
  return rec;
}

// ── attestation store (db/attest.json) — bulky quotes kept out of /api/state ─
export function saveAttestation(auditId, attestation, extra = {}) {
  if (!attestation) return;
  const db = readJSON(ATTEST, {});
  db[auditId] = {
    audit_id: auditId,
    reportData: attestation.reportData ?? null,
    mocked: !!attestation.mocked,
    quote: attestation.quote ?? null,
    event_log: attestation.event_log ?? null,
    vm_config: attestation.vm_config ?? null,
    info: attestation.info ?? null,
    verify: attestation.verify ?? "https://proof.t16z.com/",
    attested_at: attestation.attestedAt ?? now(),
    ...extra,
  };
  writeJSON(ATTEST, db);
}

export function getAttestation(auditId) {
  return readJSON(ATTEST, {})[auditId] || null;
}

// ── registered agents (db/users.json + db/auditors.json) ─────────────────────
export function saveAgent(role, record) {
  const file = role === "auditor" ? AUDITORS : USERS;
  const db = readJSON(file, {});
  db[record.agent_id] = { ...record, role };
  writeJSON(file, db);
  return db[record.agent_id];
}

// A user's agent rates + comments an auditor after a task. The comment lives in the
// AUDITOR's profile (auditors.json) and the auditor's aggregate rating is recomputed;
// the same review is also recorded on the USER's record (users.json) as a review given.
// Creates a minimal record for either side if it doesn't exist yet.
export function saveAuditorReview({ auditorId, reviewerId, rating, comment, skill, verdict, reviewSeq, voteSeq, taskTopicId }) {
  const at = now();
  const stars = Math.max(1, Math.min(5, Math.round(Number(rating) || 5)));
  const review = { reviewer: reviewerId, rating: stars, comment, skill, verdict, review_seq: reviewSeq || null, vote_seq: voteSeq || null, task_topic: taskTopicId || null, at };

  // 1) auditor profile — append the comment + recompute the aggregate rating
  const auditors = readJSON(AUDITORS, {});
  const a = auditors[auditorId] || { agent_id: auditorId, role: "auditor" };
  a.reviews = Array.isArray(a.reviews) ? a.reviews : [];
  a.reviews.push(review);
  const avg = a.reviews.reduce((s, r) => s + (Number(r.rating) || 0), 0) / a.reviews.length;
  a.rating = avg.toFixed(1);
  a.review_count = a.reviews.length;
  auditors[auditorId] = a;
  writeJSON(AUDITORS, auditors);

  // 2) user record — record the review the agent gave
  const users = readJSON(USERS, {});
  const u = users[reviewerId] || { agent_id: reviewerId, role: "user" };
  u.reviews_given = Array.isArray(u.reviews_given) ? u.reviews_given : [];
  u.reviews_given.push({ auditor: auditorId, rating: stars, comment, skill, verdict, task_topic: taskTopicId || null, at });
  users[reviewerId] = u;
  writeJSON(USERS, users);

  return { auditor_id: auditorId, rating: a.rating, review_count: a.review_count, review };
}
export function getAgent(id) {
  return readJSON(USERS, {})[id] || readJSON(AUDITORS, {})[id] || null;
}

// ── portal session (bridges a CLI login/register → the browser portal) ──
// A CLI `curl /api/login` or `register-cli` records the "currently active" agent
// here; the browser polls /api/session and adopts it, so the portal logs in too.
export function setSession(agentId) {
  writeJSON(SESSION, { agent_id: agentId || null, at: now() });
  return getSession();
}
export function getSession() {
  return readJSON(SESSION, { agent_id: null });
}
export function clearSession() {
  writeJSON(SESSION, { agent_id: null, at: now() });
}
export function listUsers() {
  return Object.values(readJSON(USERS, {}));
}
export function listAuditors() {
  return Object.values(readJSON(AUDITORS, {}));
}

// ── derived dashboard state (the single source of truth for the frontend) ───
const STAGE_NAMES = ["Scanner", "Sandbox", "Fork", "Synthesizer"];

export function deriveState() {
  const auditsDb = readJSON(AUDITS, {});
  const reg = readJSON(REGISTRY, {});
  const recs = Object.values(auditsDb).sort((a, b) => String(b.started_at || "").localeCompare(String(a.started_at || "")));

  const audits = recs.map((r) => {
    const ongoing = String(r.status || "").startsWith("auditing");
    const stageIndex = Math.max(0, Math.min(3, (r.stage || 1) - 1));
    const ev = Array.isArray(r.evidence) ? r.evidence : [];
    const steps = STAGE_NAMES.map((stage, i) => ({
      stage,
      status: !ongoing ? "done" : i < stageIndex ? "done" : i === stageIndex ? "running" : "pending",
      detail: ev[i]?.summary || (i === 3 && r.summary) || "",
    }));
    return {
      id: r.audit_id,
      skill: r.skill + (r.version ? `@v${r.version}` : ""),
      auditor: r.auditor || r.agent_id || "mars-auditor",
      agent_id: r.agent_id || "anonymous",
      tier: "T1 · STD",
      state: ongoing ? "ongoing" : "past",
      verdict: r.verdict || "AUDITING",
      stageIndex,
      escrow: "—",
      bond: "—",
      topic: r.audit_id, // the HCS task-trail topic (real Hedera 0.0.x id, == audit id)
      chatRoom: r.chat_room || null, // the HCS-16 negotiation room id
      date: r.completed_at || "now",
      steps,
      // final synthesizer output
      risk: r.risk || null,
      summary: r.summary || "",
      capabilities: r.capabilities || [],
      findings: r.findings || [],
      recommendation: r.recommendation || "",
      // attestation pointers (full quote lives in db/attest.json → /api/attest)
      attested: !!r.attestation_reportData,
      attestationMocked: !!r.attestation_mocked,
    };
  });

  const skills = Object.values(reg).map((entry) => {
    const versions = (entry.versions || []).slice().reverse();
    const latest = versions[0] || {};
    const verName = (v) => (v.verified_name || "").replace(entry.skill + "-", "") || "v1";
    const premium = !!latest.premium;
    const authorId = latest.author?.hederaId || latest.author?.evm || (latest.licensed_agents && latest.licensed_agents[0]) || "—";
    return {
      id: entry.skill,
      version: verName(latest),
      verdict: "SAFE",
      trust: 0.9,
      category: premium ? "Premium" : "—",
      premium,
      author: authorId,
      authorEvm: latest.author?.evm || null,
      authorHumanId: latest.author?.humanId || null,
      licenses: (latest.licensed_agents || []).length,
      usagePerDay: 0,
      // royalty %: a real figure for premium skills, "—" otherwise
      royalty: premium && latest.royalty_pct != null ? `${latest.royalty_pct}%` : "—",
      price: latest.price ?? null,
      escrowJobId: latest.escrow_job_id ?? null,
      licenseTokenId: latest.license_token_id ?? null,
      verifiedTokenId: latest.verified_token_id ?? null,
      reviews: { rating: 0, count: 0 },
      versions: versions.map((v) => ({ version: verName(v), verdict: "SAFE", date: v.verified_at || "—", auditId: v.audit_id || "—", premium: !!v.premium })),
    };
  });

  const regUsers = readJSON(USERS, {});
  const regAuditors = readJSON(AUDITORS, {});
  const sessions = (id) => recs.filter((r) => r.agent_id === id).length;
  const licensed = (id) => Object.values(reg).filter((e) => (e.versions || []).some((v) => (v.licensed_agents || []).includes(id))).length;

  // Pass through the on-chain identity fields a registered agent carries, so the
  // Connect Agent cell can show its full profile (never the encrypted key).
  const onchain = (a) => ({
    evm: a.evm_address || null,
    role: a.role || null,
    worldVerified: !!a.world_verified,
    humanId: a.human_id || null,
    profileTopic: a.profile_topic || null,
    votingTopic: a.voting_topic || null,
    reviewTopic: a.review_topic || null,
    accountMemo: a.account_memo || null,
    registrySeq: a.registry_seq ?? null,
    registeredAt: a.registered_at || null,
  });
  const noOnchain = { evm: null, role: null, worldVerified: false, humanId: null, profileTopic: null, votingTopic: null, reviewTopic: null, accountMemo: null, registrySeq: null, registeredAt: null };

  // users = registered users + any agent_id that ran an audit but isn't registered
  const userMap = {};
  for (const u of Object.values(regUsers)) {
    userMap[u.agent_id] = {
      id: u.agent_id,
      worldId: u.world_verified ? u.human_id || "verified" : "—",
      skills: licensed(u.agent_id),
      spend: 0,
      since: (u.registered_at || "").slice(0, 10) || "—",
      rating: parseFloat(u.rating) || 0,
      sessions: sessions(u.agent_id),
      last: recs.find((r) => r.agent_id === u.agent_id)?.skill || "—",
      active: recs.some((r) => r.agent_id === u.agent_id && String(r.status).startsWith("auditing")),
      ...onchain(u),
    };
  }
  for (const id of [...new Set(recs.map((r) => r.agent_id).filter(Boolean))]) {
    if (userMap[id] || regAuditors[id]) continue;
    userMap[id] = { id, worldId: "—", skills: licensed(id), spend: 0, since: "—", rating: 0, sessions: sessions(id), last: recs.find((r) => r.agent_id === id)?.skill || "—", active: recs.some((r) => r.agent_id === id && String(r.status).startsWith("auditing")), ...noOnchain, role: "user" };
  }
  const users = Object.values(userMap);

  const auditors = Object.values(regAuditors).map((a) => ({
    id: a.agent_id,
    worldId: a.world_verified ? a.human_id || "verified" : "—",
    status: "active",
    rep: 0.9,
    rating: parseFloat(a.rating) || 0,
    proposed: recs.filter((r) => r.auditor === a.agent_id).length,
    processed: 0,
    accuracy: 0,
    stake: 0,
    region: "—",
    spec: a.spec || "—",
    last: (a.registered_at || "").slice(0, 10) || "—",
    ...onchain(a),
  }));

  const stats = {
    auditsInFlight: recs.filter((r) => String(r.status).startsWith("auditing")).length,
    skillsVerified: skills.length,
    flagged: recs.filter((r) => r.verdict === "DANGEROUS").length,
    agents: users.length + auditors.length,
    users: users.length,
    auditors: auditors.length,
  };

  return { stats, audits, skills, auditors, users };
}

export function failAudit(auditId, error) {
  const db = readJSON(AUDITS, {});
  const rec = db[auditId] || { audit_id: auditId };
  rec.status = "failed";
  rec.error = String(error);
  rec.completed_at = now();
  db[auditId] = rec;
  writeJSON(AUDITS, db);
  return rec;
}

// ── verified skill store + access grant ─────────────────────────────────────
// Saves files to skills/<name>-v<N> and registers that agentId may use it
// (they paid for the audit). `extra` merges premium fields onto the version entry.
// Returns { verified_name, version, path }.
export function saveVerifiedSkill({ skill, files, agentId, auditId, fileSha256, extra = {} }) {
  const base = sanitize(skill);
  const reg = readJSON(REGISTRY, {});
  const entry = reg[base] || { skill: base, versions: [] };
  const version = entry.versions.length + 1;
  const verifiedName = `${base}-v${version}`;
  const dir = join(SKILLS_DIR, verifiedName);

  for (const f of files || []) {
    const fp = join(dir, safeRel(f.name));
    mkdirSync(dirname(fp), { recursive: true });
    writeFileSync(fp, f.content);
  }

  entry.versions.push({
    version,
    verified_name: verifiedName,
    path: `skills/${verifiedName}`,
    audit_id: auditId,
    file_sha256: fileSha256,
    licensed_agents: agentId ? [agentId] : [],
    verified_at: now(),
    ...extra,
  });
  reg[base] = entry;
  writeJSON(REGISTRY, reg);
  return { verified_name: verifiedName, version, path: `skills/${verifiedName}` };
}

// ── premium (author-published) skill ────────────────────────────────────────
// Like saveVerifiedSkill, but stamps the author identity + royalty terms + the
// on-chain pointers (Arc escrow job, Hedera license/verified tokens) so the
// dashboard can list it as a royalty-bearing PREMIUM skill.
export function savePremiumSkill({
  skill, files, author, royaltyPct, price, escrowJobId,
  licenseTokenId, verifiedTokenId, auditId, fileSha256,
}) {
  return saveVerifiedSkill({
    skill, files, agentId: author?.hederaId, auditId, fileSha256,
    extra: {
      premium: true,
      author: author || null,
      royalty_pct: royaltyPct ?? null,
      price: price ?? null,
      escrow_job_id: escrowJobId ?? null,
      license_token_id: licenseTokenId ?? null,
      verified_token_id: verifiedTokenId ?? null,
    },
  });
}

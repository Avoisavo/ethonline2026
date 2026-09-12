import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync, renameSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { AGENTS, type Agent } from "./agents";
import type { AnchorSnapshot, ContinuityState } from "./policy";

/**
 * Demo-grade persistence.
 *
 * A real relying party stores nullifiers in a table with a UNIQUE constraint on
 * (nullifier, action) — that constraint is what makes replay impossible. Here a
 * JSON file in the OS temp dir stands in for it, so state survives Turbopack
 * HMR and dev-server restarts while staying out of the repo.
 */

const STORE_DIR = join(tmpdir(), "selfie-check-continuity-demo");
const STORE_FILE = join(STORE_DIR, "accounts.json");

export type DemoEvent = {
  at: number;
  kind:
    | "anchor_created"
    | "continuity_confirmed"
    | "continuity_broken"
    | "verification_failed"
    | "action_allowed"
    | "action_denied"
    | "agent_assigned"
    | "agent_reclaimed"
    | "agent_unavailable"
    | "reset";
  summary: string;
  detail?: string;
  /**
   * Where the event came from. Every proof is live now, but the field stays on
   * the record so an audit trail can never be ambiguous about provenance.
   */
  source?: "live";
  /** HTTP status from the Developer Portal, when a verify call was made. */
  verifyStatus?: number | null;
};

export type AccountRecord = {
  id: string;
  anchorNullifier: string | null;
  anchoredAt: number | null;
  lastNullifier: string | null;
  lastVerifiedAt: number | null;
  credentialIssuedAt: number | null;
  /** Every nullifier ever accepted for this account, for replay detection. */
  seenNullifiers: string[];
  /** rp_context nonces already spent, for duplicate_nonce detection. */
  usedNonces: string[];
  /** Audit counter — a continuity break stays on the record even after the
   * owner re-verifies and the live signal returns to `intact`. */
  continuityBreaks: number;
  events: DemoEvent[];
};

/**
 * One human's claim on one agent.
 *
 * Keyed by `${action}:${nullifier}` in the registry. The action is part of the
 * key because nullifiers are scoped per action — the same human on a different
 * action is a different nullifier, so a key without the action would silently
 * merge two different identity spaces.
 */
export type AgentClaim = {
  agentId: string;
  action: string;
  nullifier: string;
  claimedAt: number;
  /** The account the claim was first made from, for audit only. */
  firstAccountId: string;
  /** Distinct account cookies that have presented this nullifier. */
  accountIds: string[];
  /** How many times this human has re-verified and been handed the same agent. */
  reclaims: number;
};

type StoreShape = {
  accounts: Record<string, AccountRecord>;
  /** `${action}:${nullifier}` -> claim. This is the UNIQUE constraint. */
  agentClaims?: Record<string, AgentClaim>;
};

function claimKey(action: string, nullifier: string): string {
  return `${action}:${nullifier}`;
}

function load(): StoreShape {
  try {
    const parsed = JSON.parse(readFileSync(STORE_FILE, "utf8")) as StoreShape;
    return { accounts: parsed.accounts ?? {}, agentClaims: parsed.agentClaims ?? {} };
  } catch {
    return { accounts: {}, agentClaims: {} };
  }
}

/**
 * Write atomically: serialize to a temp file in the same directory, then
 * rename over the target. rename(2) is atomic within a filesystem, so a reader
 * never observes a half-written file.
 *
 * This matters more than it looks. `load()` falls back to an EMPTY store on a
 * parse error, so a torn write would read back as "no agent claims exist" and
 * the registry would happily re-issue agents that are already held.
 */
function persist(store: StoreShape): void {
  mkdirSync(STORE_DIR, { recursive: true });
  const tmp = `${STORE_FILE}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  writeFileSync(tmp, JSON.stringify(store, null, 2), "utf8");
  renameSync(tmp, STORE_FILE);
}

function emptyAccount(id: string): AccountRecord {
  return {
    id,
    anchorNullifier: null,
    anchoredAt: null,
    lastNullifier: null,
    lastVerifiedAt: null,
    credentialIssuedAt: null,
    seenNullifiers: [],
    usedNonces: [],
    continuityBreaks: 0,
    events: [],
  };
}

export function newAccountId(): string {
  return `acct_${randomBytes(8).toString("hex")}`;
}

export function getAccount(id: string): AccountRecord {
  const store = load();
  const found = store.accounts[id];
  if (!found) return emptyAccount(id);
  // Records persisted by an earlier shape may be missing newer fields.
  return { ...emptyAccount(id), ...found };
}

export function saveAccount(record: AccountRecord): void {
  const store = load();
  store.accounts[record.id] = record;
  persist(store);
}

export function resetAccount(id: string): AccountRecord {
  const fresh = emptyAccount(id);
  fresh.events = [
    { at: Date.now(), kind: "reset", summary: "Demo state cleared." },
  ];
  saveAccount(fresh);
  return fresh;
}

export function pushEvent(record: AccountRecord, event: DemoEvent): void {
  record.events.unshift(event);
  record.events = record.events.slice(0, 40);
}

/** Derive the policy-facing snapshot from the stored record. */
export function toSnapshot(record: AccountRecord): AnchorSnapshot {
  let continuity: ContinuityState = "unanchored";
  if (record.anchorNullifier != null) {
    continuity =
      record.lastNullifier != null &&
      record.lastNullifier !== record.anchorNullifier
        ? "broken"
        : "intact";
  }
  return {
    anchorNullifier: record.anchorNullifier,
    anchoredAt: record.anchoredAt,
    lastNullifier: record.lastNullifier,
    lastVerifiedAt: record.lastVerifiedAt,
    credentialIssuedAt: record.credentialIssuedAt,
    continuity,
  };
}

export type ClaimResult =
  | { status: "assigned"; agent: Agent; claim: AgentClaim }
  | { status: "returning"; agent: Agent; claim: AgentClaim }
  | { status: "exhausted"; total: number };

/**
 * Claim the one agent this human is entitled to.
 *
 * This is deliberately ONE exported function that loads, checks and writes in a
 * single synchronous pass. It is not split into a `lookupClaim` export plus a
 * `saveClaim` export, because any caller that did lookup-then-save would
 * reintroduce exactly the race a UNIQUE constraint exists to remove: two
 * concurrent registrations both read "free" and both write.
 *
 * Node runs this handler on one thread and there is no `await` between the read
 * and the write, so the sequence cannot interleave with another request in this
 * process. That is the whole guarantee — and its limit: it holds for a single
 * process. A multi-instance or serverless deploy needs a real database with a
 * UNIQUE (action, nullifier) constraint, which is what this function stands in
 * for. Do not add an `await` inside it.
 *
 * Idempotent by design: the same human re-verifying gets the SAME agent back
 * rather than an error, because "you may only use one agent" and "you may only
 * verify once" are different rules. Only the first call allocates.
 */
export function claimAgent(
  action: string,
  nullifier: string,
  accountId: string,
): ClaimResult {
  const store = load();
  const claims = store.agentClaims ?? {};
  const key = claimKey(action, nullifier);

  const existing = claims[key];
  if (existing) {
    const agent = AGENTS.find((a) => a.id === existing.agentId);
    if (agent) {
      existing.reclaims += 1;
      if (!existing.accountIds.includes(accountId)) {
        existing.accountIds.push(accountId);
      }
      claims[key] = existing;
      store.agentClaims = claims;
      persist(store);
      return { status: "returning", agent, claim: existing };
    }
    // The stored agentId is not in the roster any more (roster edited between
    // runs). Fall through and allocate again rather than handing back nothing.
  }

  const taken = new Set(Object.values(claims).map((c) => c.agentId));
  const free = AGENTS.find((a) => !taken.has(a.id));
  if (!free) {
    return { status: "exhausted", total: AGENTS.length };
  }

  const claim: AgentClaim = {
    agentId: free.id,
    action,
    nullifier,
    claimedAt: Date.now(),
    firstAccountId: accountId,
    accountIds: [accountId],
    reclaims: 0,
  };
  claims[key] = claim;
  store.agentClaims = claims;
  persist(store);
  return { status: "assigned", agent: free, claim };
}

/** Read-only view of this human's claim, for rendering. Never allocates. */
export function findClaimByNullifier(
  action: string,
  nullifier: string | null,
): AgentClaim | null {
  if (!nullifier) return null;
  const store = load();
  return store.agentClaims?.[claimKey(action, nullifier)] ?? null;
}

/** Roster occupancy, for showing how scarce the remaining agents are. */
export function rosterStatus(): { taken: number; total: number } {
  const store = load();
  const taken = new Set(
    Object.values(store.agentClaims ?? {}).map((c) => c.agentId),
  );
  return { taken: taken.size, total: AGENTS.length };
}

/** Short display form for a 256-bit nullifier. */
export function shortNullifier(nullifier: string | null): string {
  if (!nullifier) return "—";
  return `${nullifier.slice(0, 10)}…${nullifier.slice(-6)}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

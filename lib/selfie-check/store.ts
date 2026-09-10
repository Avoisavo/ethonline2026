import "server-only";
import { createHash, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

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
    | "reset";
  summary: string;
  detail?: string;
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

type StoreShape = { accounts: Record<string, AccountRecord> };

function load(): StoreShape {
  try {
    return JSON.parse(readFileSync(STORE_FILE, "utf8")) as StoreShape;
  } catch {
    return { accounts: {} };
  }
}

function persist(store: StoreShape): void {
  mkdirSync(STORE_DIR, { recursive: true });
  writeFileSync(STORE_FILE, JSON.stringify(store, null, 2), "utf8");
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

/** Short display form for a 256-bit nullifier. */
export function shortNullifier(nullifier: string | null): string {
  if (!nullifier) return "—";
  return `${nullifier.slice(0, 10)}…${nullifier.slice(-6)}`;
}

export function sha256Hex(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

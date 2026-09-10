import "server-only";

import { getConfig } from "./config";
import { SCENARIOS } from "./mock";
import {
  ACTIONS,
  credentialExpiresAt,
  evaluate,
  proofAgeSeconds,
} from "./policy";
import { getAccount, shortNullifier, toSnapshot } from "./store";

/**
 * Build the full console state for an account.
 *
 * Shared by the `/face` page (server-rendered first paint) and the
 * `/api/selfie-check/state` handler (refresh after a mutation), so both always
 * agree. `accountId: null` means the browser has no demo cookie yet — the
 * cookie gets minted by the first mutating request.
 */
export function buildState(accountId: string | null) {
  const config = getConfig();
  const record = getAccount(accountId ?? "acct_pending");
  const snapshot = toSnapshot(record);
  const now = Date.now();

  return {
    mode: config.mode,
    action: config.action,
    missingEnv: config.mode === "mock" ? config.missing : [],
    account: {
      id: accountId ?? "not yet assigned",
      continuity: snapshot.continuity,
      anchorShort: shortNullifier(snapshot.anchorNullifier),
      lastShort: shortNullifier(snapshot.lastNullifier),
      anchoredAt: snapshot.anchoredAt,
      lastVerifiedAt: snapshot.lastVerifiedAt,
      proofAgeSeconds: proofAgeSeconds(snapshot, now),
      credentialExpiresAt: credentialExpiresAt(snapshot),
      continuityBreaks: record.continuityBreaks,
    },
    decisions: ACTIONS.map((a) => evaluate(a, snapshot, now)),
    scenarios: SCENARIOS,
    events: record.events,
    now,
  };
}

export type ConsoleState = ReturnType<typeof buildState>;

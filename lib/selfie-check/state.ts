import "server-only";

import { environmentAsymmetry, getConfig, type ConfigProblem } from "./config";
import {
  ACTIONS,
  credentialExpiresAt,
  evaluate,
  proofAgeSeconds,
} from "./policy";
import { findAgent } from "./agents";
import {
  findClaimByNullifier,
  getAccount,
  rosterStatus,
  shortNullifier,
  toSnapshot,
} from "./store";

/**
 * Build the full console state for an account.
 *
 * Shared by the `/face` page (server-rendered first paint) and the
 * `/api/selfie-check/state` handler (refresh after a mutation), so both always
 * agree. `accountId: null` means the browser has no demo cookie yet — the
 * cookie gets minted by the first mutating request.
 */
export function buildState(accountId: string | null) {
  const result = getConfig();
  const record = getAccount(accountId ?? "acct_pending");
  const snapshot = toSnapshot(record);
  const now = Date.now();

  const configured = result.ok;
  const problems: ConfigProblem[] = result.ok ? [] : result.problems;

  return {
    configured,
    problems,
    action: result.ok ? result.config.action : null,
    appId: result.ok ? result.config.appId : null,
    environment: result.ok ? result.config.environment : null,
    proofVersion: result.ok ? result.config.proofVersion : null,
    environmentNote: result.ok ? environmentAsymmetry(result.config) : null,
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
    // Looked up by the account's ANCHOR nullifier, not the account id: the
    // claim belongs to the human, so it survives clearing the cookie and
    // follows the same human into a new browser session.
    agent: buildAgentView(
      result.ok ? result.config.action : null,
      snapshot.anchorNullifier,
    ),
    roster: rosterStatus(),
    events: record.events,
    now,
  };
}

function buildAgentView(action: string | null, anchorNullifier: string | null) {
  if (!action || !anchorNullifier) return null;
  const claim = findClaimByNullifier(action, anchorNullifier);
  if (!claim) return null;
  const agent = findAgent(claim.agentId);
  if (!agent) return null;
  return {
    id: agent.id,
    callsign: agent.callsign,
    role: agent.role,
    claimedAt: claim.claimedAt,
    reclaims: claim.reclaims,
    sessions: claim.accountIds.length,
    nullifierShort: shortNullifier(claim.nullifier),
  };
}

export type ConsoleState = ReturnType<typeof buildState>;

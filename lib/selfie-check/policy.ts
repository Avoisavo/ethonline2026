import {
  MAX_AGE_MAX_SECONDS,
  MAX_AGE_MIN_SECONDS,
  SELFIE_VALIDITY_DAYS,
} from "./types";

/**
 * The continuity policy.
 *
 * Selfie Check is a *low-friction, medium-assurance* credential. It does not
 * promise one-person-one-account the way an Orb credential does, so this demo
 * does not use it as a personhood oracle. It uses the two things it is actually
 * good at:
 *
 *   1. CONTINUITY — the nullifier is deterministic for a given
 *      (credential, app_id, action) triple. Re-verifying later yields the *same*
 *      nullifier for the same human and a different one for anybody else. That
 *      makes it a cheap "is the person holding this account still the person who
 *      opened it?" check, which is exactly the question account recovery and
 *      high-value actions need answered.
 *
 *   2. FRESHNESS — `max_age` on the verify endpoint (bounded 3600..604800s)
 *      lets each action demand a proof minted within its own window. A 90-day
 *      credential is not a 90-day session.
 *
 * IMPORTANT integration constraint: the action string must be STABLE across
 * sessions. Nullifiers are scoped per action, so rotating the action (a natural
 * instinct if you think of it as a per-request nonce) silently destroys
 * continuity — every check would look like a brand-new human. The nonce lives in
 * `rp_context`, not in the action.
 */

export type Tier = "open" | "sensitive" | "critical";

export type GatedAction = {
  id: string;
  label: string;
  blurb: string;
  tier: Tier;
  /** Proof must resolve to the same nullifier the account was anchored with. */
  requiresAnchorMatch: boolean;
  /** Max proof age, in seconds, sent to the verify endpoint as `max_age`. */
  maxAgeSeconds: number | null;
};

export const ACTIONS: GatedAction[] = [
  {
    id: "view_balance",
    label: "View balance",
    blurb: "Read-only. No biometric signal required.",
    tier: "open",
    requiresAnchorMatch: false,
    maxAgeSeconds: null,
  },
  {
    id: "update_recovery_email",
    label: "Update recovery email",
    blurb:
      "Account-takeover target. Needs the same human, verified within the last 7 days.",
    tier: "sensitive",
    requiresAnchorMatch: true,
    maxAgeSeconds: MAX_AGE_MAX_SECONDS, // 604800 — the endpoint's ceiling
  },
  {
    id: "withdraw",
    label: "Withdraw funds",
    blurb:
      "Irreversible. Needs the same human, verified within the last hour.",
    tier: "critical",
    requiresAnchorMatch: true,
    maxAgeSeconds: MAX_AGE_MIN_SECONDS, // 3600 — the endpoint's floor
  },
  {
    id: "recover_device",
    label: "Recover on new device",
    blurb:
      "The continuity case. Re-anchor a reinstalled account by matching the enrolled face.",
    tier: "critical",
    requiresAnchorMatch: true,
    maxAgeSeconds: MAX_AGE_MIN_SECONDS,
  },
];

export function findAction(id: string): GatedAction | undefined {
  return ACTIONS.find((a) => a.id === id);
}

export type ContinuityState = "unanchored" | "intact" | "broken";

export type CheckStatus = "pass" | "fail" | "skip" | "warn";

/** One line in the decision trace the UI renders. */
export type DecisionCheck = {
  id: string;
  label: string;
  status: CheckStatus;
  detail: string;
};

export type StepUp = {
  kind: "enroll" | "refresh" | "manual_review";
  maxAgeSeconds: number | null;
  message: string;
};

export type Decision = {
  action: GatedAction;
  allowed: boolean;
  checks: DecisionCheck[];
  stepUp: StepUp | null;
};

/** What the server knows about an account's human anchor. */
export type AnchorSnapshot = {
  /** Nullifier the account was first anchored with. */
  anchorNullifier: string | null;
  anchoredAt: number | null;
  /** Nullifier from the most recent successful verification. */
  lastNullifier: string | null;
  /** Unix ms of the most recent successful verification. */
  lastVerifiedAt: number | null;
  /** Unix ms the underlying Selfie Check credential was issued. */
  credentialIssuedAt: number | null;
  continuity: ContinuityState;
};

export function proofAgeSeconds(
  snapshot: AnchorSnapshot,
  now: number,
): number | null {
  if (snapshot.lastVerifiedAt == null) return null;
  return Math.max(0, Math.floor((now - snapshot.lastVerifiedAt) / 1000));
}

export function credentialExpiresAt(snapshot: AnchorSnapshot): number | null {
  if (snapshot.credentialIssuedAt == null) return null;
  return snapshot.credentialIssuedAt + SELFIE_VALIDITY_DAYS * 86400 * 1000;
}

function humanizeAge(seconds: number): string {
  if (seconds < 60) return `${seconds}s ago`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h ago`;
  return `${Math.floor(seconds / 86400)}d ago`;
}

function humanizeWindow(seconds: number): string {
  if (seconds % 86400 === 0) return `${seconds / 86400}d`;
  if (seconds % 3600 === 0) return `${seconds / 3600}h`;
  return `${seconds}s`;
}

/**
 * Evaluate one gated action against the account's current signal state.
 *
 * Returns the full check trace, not just a boolean, so the UI can show *why*
 * a low-assurance credential was or wasn't sufficient.
 */
export function evaluate(
  action: GatedAction,
  snapshot: AnchorSnapshot,
  now: number = Date.now(),
): Decision {
  const checks: DecisionCheck[] = [];

  if (action.tier === "open") {
    checks.push({
      id: "tier",
      label: "Action tier",
      status: "pass",
      detail: "Open tier — no biometric signal required.",
    });
    return { action, allowed: true, checks, stepUp: null };
  }

  checks.push({
    id: "tier",
    label: "Action tier",
    status: "pass",
    detail: `${action.tier} — requires a Selfie Check signal.`,
  });

  // 1. Is there an anchor at all?
  if (snapshot.anchorNullifier == null) {
    checks.push({
      id: "anchor",
      label: "Human anchor",
      status: "fail",
      detail: "No anchor on file. Account has never completed a Selfie Check.",
    });
    return {
      action,
      allowed: false,
      checks,
      stepUp: {
        kind: "enroll",
        maxAgeSeconds: action.maxAgeSeconds,
        message: "Enroll a human anchor to continue.",
      },
    };
  }

  checks.push({
    id: "anchor",
    label: "Human anchor",
    status: "pass",
    detail: `Anchored ${humanizeAge(Math.floor((now - (snapshot.anchoredAt ?? now)) / 1000))}.`,
  });

  // 2. Does the latest proof still match the anchor?
  if (action.requiresAnchorMatch) {
    if (snapshot.continuity === "broken") {
      checks.push({
        id: "continuity",
        label: "Continuity",
        status: "fail",
        detail:
          "Latest nullifier does not match the anchor — a different human passed liveness on this account.",
      });
      return {
        action,
        allowed: false,
        checks,
        stepUp: {
          kind: "manual_review",
          maxAgeSeconds: null,
          message:
            "Continuity break. A fresh selfie cannot clear this — the credential is medium-assurance, so escalate instead of retrying.",
        },
      };
    }
    checks.push({
      id: "continuity",
      label: "Continuity",
      status: "pass",
      detail: "Latest nullifier matches the anchor. Same human.",
    });
  } else {
    checks.push({
      id: "continuity",
      label: "Continuity",
      status: "skip",
      detail: "Not required for this action.",
    });
  }

  // 3. Is the proof fresh enough for this tier?
  const age = proofAgeSeconds(snapshot, now);
  if (action.maxAgeSeconds != null) {
    if (age == null) {
      checks.push({
        id: "freshness",
        label: "Proof freshness",
        status: "fail",
        detail: "No verification on record.",
      });
      return {
        action,
        allowed: false,
        checks,
        stepUp: {
          kind: "refresh",
          maxAgeSeconds: action.maxAgeSeconds,
          message: "Run a Selfie Check to continue.",
        },
      };
    }
    if (age > action.maxAgeSeconds) {
      checks.push({
        id: "freshness",
        label: "Proof freshness",
        status: "fail",
        detail: `Proof is ${humanizeAge(age)}, older than this tier's ${humanizeWindow(action.maxAgeSeconds)} window (max_age=${action.maxAgeSeconds}).`,
      });
      return {
        action,
        allowed: false,
        checks,
        stepUp: {
          kind: "refresh",
          maxAgeSeconds: action.maxAgeSeconds,
          message: `Step up: re-verify to get inside the ${humanizeWindow(action.maxAgeSeconds)} window.`,
        },
      };
    }
    checks.push({
      id: "freshness",
      label: "Proof freshness",
      status: "pass",
      detail: `Verified ${humanizeAge(age)}, inside the ${humanizeWindow(action.maxAgeSeconds)} window (max_age=${action.maxAgeSeconds}).`,
    });
  }

  // 4. Is the underlying credential still inside its 90-day validity?
  const expiry = credentialExpiresAt(snapshot);
  if (expiry != null) {
    const daysLeft = Math.floor((expiry - now) / 86400000);
    if (daysLeft < 0) {
      checks.push({
        id: "credential_validity",
        label: "Credential validity",
        status: "fail",
        detail: `Selfie Check credential expired ${-daysLeft}d ago (${SELFIE_VALIDITY_DAYS}-day validity).`,
      });
      return {
        action,
        allowed: false,
        checks,
        stepUp: {
          kind: "refresh",
          maxAgeSeconds: action.maxAgeSeconds,
          message: "Credential lapsed. Re-enroll to restore the anchor.",
        },
      };
    }
    checks.push({
      id: "credential_validity",
      label: "Credential validity",
      status: daysLeft <= 14 ? "warn" : "pass",
      detail:
        daysLeft <= 14
          ? `Expires in ${daysLeft}d — inside the re-enrollment window.`
          : `${daysLeft}d left of the ${SELFIE_VALIDITY_DAYS}-day validity.`,
    });
  }

  return { action, allowed: true, checks, stepUp: null };
}

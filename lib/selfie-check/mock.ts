import "server-only";
import { randomBytes } from "node:crypto";

import { sha256Hex } from "./store";
import {
  SELFIE_IDENTIFIER,
  type IDKitErrorCode,
  type IDKitResultV3,
} from "./types";

/**
 * Local Selfie Check proof engine.
 *
 * Selfie Check is access-gated beta, so until an app is enabled this stands in
 * for World App. It reproduces the payload *shape* of a real
 * `selfieCheckLegacy()` result (World ID 3.0) and, more importantly, the
 * behaviours that are hard to trigger on demand in the sandbox:
 *
 *   - the three sandbox user states (hot / cold / semi-cold)
 *   - a second human passing liveness on the same account
 *   - a proof that is valid but too old for the action's max_age
 *   - a credential near the end of its 90-day validity
 *   - every World App error code, on demand
 *
 * The nullifier is derived deterministically from (face, app_id, action), which
 * is the property real continuity checks lean on: same human + same action =>
 * same nullifier. It is NOT a real Semaphore nullifier and proves nothing.
 */

/** A simulated face. `faceSeed` stands in for the enrolled biometric template. */
type Persona = {
  id: string;
  label: string;
  faceSeed: string;
};

const PERSONAS: Record<string, Persona> = {
  primary: { id: "primary", label: "Account owner", faceSeed: "face-owner-01" },
  attacker: {
    id: "attacker",
    label: "Different human",
    faceSeed: "face-other-77",
  },
};

export type SandboxUserState = "hot" | "cold" | "semi_cold";

export type MockScenario = {
  id: string;
  label: string;
  group: "success" | "continuity" | "freshness" | "error";
  blurb: string;
  /** Sandbox user state this mirrors, where applicable. */
  userState?: SandboxUserState;
  persona?: keyof typeof PERSONAS;
  /** Backdate the resulting proof by this many seconds. */
  proofAgeSeconds?: number;
  /** How long ago the underlying credential was issued, in days. */
  credentialAgeDays?: number;
  /** Fail instead of producing a proof. */
  errorCode?: IDKitErrorCode;
};

export const SCENARIOS: MockScenario[] = [
  {
    id: "hot_same_human",
    label: "Hot — same human",
    group: "success",
    blurb:
      "World App installed, Selfie Check already enrolled. Straight to face match.",
    userState: "hot",
    persona: "primary",
    credentialAgeDays: 3,
  },
  {
    id: "cold_new_human",
    label: "Cold — first-time user",
    group: "success",
    blurb:
      "No World App yet: install, create account, enroll Selfie Check, then match.",
    userState: "cold",
    persona: "primary",
    credentialAgeDays: 0,
  },
  {
    id: "semi_cold_same_human",
    label: "Semi-cold — recovered on new device",
    group: "continuity",
    blurb:
      "The continuity case. Reinstall and account recovery on a new phone still yields the same nullifier.",
    userState: "semi_cold",
    persona: "primary",
    credentialAgeDays: 12,
  },
  {
    id: "different_human",
    label: "Different human passes liveness",
    group: "continuity",
    blurb:
      "Someone else completes a real Selfie Check on this account. Liveness passes; continuity does not.",
    userState: "hot",
    persona: "attacker",
    credentialAgeDays: 1,
  },
  {
    id: "stale_proof",
    label: "Stale proof (3 hours)",
    group: "freshness",
    blurb:
      "Same human, genuine proof, minted 3 hours ago. Shows the tiers diverging: the 7-day tier accepts it, the 1-hour tier makes you step up.",
    userState: "hot",
    persona: "primary",
    proofAgeSeconds: 3 * 3600,
    credentialAgeDays: 20,
  },
  {
    id: "very_stale_proof",
    label: "Stale proof (9 days)",
    group: "freshness",
    blurb:
      "Same human, but past 604800s — the ceiling max_age accepts. Every gated tier now requires a step-up.",
    userState: "hot",
    persona: "primary",
    proofAgeSeconds: 9 * 86400,
    credentialAgeDays: 30,
  },
  {
    id: "expiring_credential",
    label: "Credential expiring in 6 days",
    group: "freshness",
    blurb:
      "Same human, fresh proof, but the 90-day Selfie Check credential is nearly lapsed.",
    userState: "hot",
    persona: "primary",
    credentialAgeDays: 84,
  },
  {
    id: "err_user_rejected",
    label: "user_rejected",
    group: "error",
    blurb: "User dismissed the World App sheet.",
    errorCode: "user_rejected",
  },
  {
    id: "err_verification_rejected",
    label: "verification_rejected",
    group: "error",
    blurb: "Liveness or face match failed inside World App.",
    errorCode: "verification_rejected",
  },
  {
    id: "err_credential_unavailable",
    label: "credential_unavailable",
    group: "error",
    blurb: "User has World App but has never enrolled Selfie Check.",
    errorCode: "credential_unavailable",
  },
  {
    id: "err_feature_unavailable",
    label: "feature_unavailable",
    group: "error",
    blurb:
      "Selfie Check is not enabled for this app_id — the beta gate. The most likely first error in a real integration.",
    errorCode: "feature_unavailable",
  },
  {
    id: "err_max_verifications_reached",
    label: "max_verifications_reached",
    group: "error",
    blurb: "Action's verification cap hit for this credential.",
    errorCode: "max_verifications_reached",
  },
  {
    id: "err_invalid_rp_signature",
    label: "invalid_rp_signature",
    group: "error",
    blurb:
      "rp_context signature rejected. Usually SHA3-256 used where Keccak-256 was required.",
    errorCode: "invalid_rp_signature",
  },
  {
    id: "err_rp_signature_expired",
    label: "rp_signature_expired",
    group: "error",
    blurb: "rp_context outlived its TTL (300s default) before the user finished.",
    errorCode: "rp_signature_expired",
  },
  {
    id: "err_connection_failed",
    label: "connection_failed",
    group: "error",
    blurb: "Bridge dropped between the browser and World App.",
    errorCode: "connection_failed",
  },
];

export function findScenario(id: string): MockScenario | undefined {
  return SCENARIOS.find((s) => s.id === id);
}

/**
 * Deterministic stand-in for a Semaphore nullifier.
 * Same (face, app, action) always produces the same value.
 */
function deriveNullifier(
  faceSeed: string,
  appId: string,
  action: string,
): string {
  return `0x${sha256Hex(`${faceSeed}|${appId}|${action}`)}`;
}

export type MockOutcome =
  | {
      ok: true;
      result: IDKitResultV3;
      /** Demo metadata the real payload does not carry. */
      meta: {
        scenarioId: string;
        personaLabel: string;
        userState: SandboxUserState;
        /** Unix ms the proof should be treated as having been minted. */
        mintedAt: number;
        credentialIssuedAt: number;
      };
    }
  | { ok: false; errorCode: IDKitErrorCode; scenarioId: string };

export function runMockScenario(opts: {
  scenario: MockScenario;
  appId: string;
  action: string;
  nonce: string;
  signalHash?: string;
}): MockOutcome {
  const { scenario, appId, action, nonce, signalHash } = opts;

  if (scenario.errorCode) {
    return {
      ok: false,
      errorCode: scenario.errorCode,
      scenarioId: scenario.id,
    };
  }

  const persona = PERSONAS[scenario.persona ?? "primary"];
  const now = Date.now();
  const mintedAt = now - (scenario.proofAgeSeconds ?? 0) * 1000;
  const credentialIssuedAt = now - (scenario.credentialAgeDays ?? 0) * 86400000;

  const result: IDKitResultV3 = {
    protocol_version: "3.0",
    nonce,
    action,
    responses: [
      {
        identifier: SELFIE_IDENTIFIER,
        signal_hash: signalHash,
        // Real proofs are ABI-encoded Groth16; shape-accurate filler here.
        proof: `0x${randomBytes(256).toString("hex")}`,
        merkle_root: `0x${randomBytes(32).toString("hex")}`,
        nullifier: deriveNullifier(persona.faceSeed, appId, action),
      },
    ],
    user_presence_completed: true,
    environment: "sandbox",
  };

  return {
    ok: true,
    result,
    meta: {
      scenarioId: scenario.id,
      personaLabel: persona.label,
      userState: scenario.userState ?? "hot",
      mintedAt,
      credentialIssuedAt,
    },
  };
}

import "server-only";

import { DEVELOPER_PORTAL, type SelfieCheckConfig } from "./config";
import {
  MAX_AGE_MAX_SECONDS,
  MAX_AGE_MIN_SECONDS,
  SELFIE_VERIFICATION_LEVEL,
  type ResponseItemV3,
  type VerifyResponse,
} from "./types";

/**
 * Server-side proof verification against the Developer Portal.
 *
 * Selfie Check emits World ID 3.0 proofs, so verification goes through the
 * legacy endpoint:
 *
 *   POST https://developer.world.org/api/v2/verify/{app_id}
 *
 * Note the field rename: IDKit's `ResponseItemV3` calls it `nullifier`, the
 * verify endpoint wants `nullifier_hash`. Passing the IDKit item straight
 * through fails with `invalid_proof` and no hint about which field was wrong.
 */

export type VerifyArgs = {
  config: Extract<SelfieCheckConfig, { mode: "live" }>;
  item: ResponseItemV3;
  action: string;
  /** Clamped into the endpoint's accepted 3600..604800 range. */
  maxAgeSeconds?: number | null;
};

export function clampMaxAge(seconds: number | null | undefined): number | null {
  if (seconds == null) return null;
  return Math.min(MAX_AGE_MAX_SECONDS, Math.max(MAX_AGE_MIN_SECONDS, seconds));
}

export type VerifyAttempt = {
  request: Record<string, unknown>;
  status: number;
  response: VerifyResponse;
};

export async function verifySelfieProof(
  args: VerifyArgs,
): Promise<VerifyAttempt> {
  const { config, item, action } = args;
  const maxAge = clampMaxAge(args.maxAgeSeconds);

  const body: Record<string, unknown> = {
    nullifier_hash: item.nullifier,
    proof: item.proof,
    merkle_root: item.merkle_root,
    verification_level: SELFIE_VERIFICATION_LEVEL,
    action,
  };
  if (item.signal_hash) body.signal_hash = item.signal_hash;
  if (maxAge != null) body.max_age = maxAge;

  const res = await fetch(
    `${DEVELOPER_PORTAL}/api/v2/verify/${config.appId}`,
    {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    },
  );

  let parsed: VerifyResponse;
  try {
    parsed = (await res.json()) as VerifyResponse;
  } catch {
    parsed = {
      success: false,
      code: "unexpected_response",
      detail: `Verify endpoint returned ${res.status} with a non-JSON body.`,
    };
  }

  // Redact the proof before it can reach a log or the client inspector.
  const safeRequest = { ...body, proof: `${item.proof.slice(0, 18)}… (truncated)` };

  return { request: safeRequest, status: res.status, response: parsed };
}

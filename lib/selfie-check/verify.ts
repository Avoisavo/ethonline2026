import "server-only";

import type { SelfieCheckConfig } from "./config";
import {
  MAX_AGE_MAX_SECONDS,
  MAX_AGE_MIN_SECONDS,
  isSelfieIdentifier,
  type ResponseItemV3,
} from "./types";

/**
 * Server-side proof verification against the Developer Portal.
 *
 * Verification goes to `POST /api/v4/verify/{rp_id}`, keyed by rp_id. That is
 * the only path this app uses, and the legacy `POST /api/v2/verify/{app_id}`
 * is deliberately not implemented — it is unusable here, which costs time to
 * discover because the failure looks like a configuration problem rather than a
 * routing one. Measured against this app:
 *
 *   v2 resolves the action against a pre-registered action registry FIRST. On
 *   an app that completed World ID 4.0 RP registration it answers
 *   `invalid_action` for every action — including one that visibly exists in
 *   the portal — because it reads a registry this app does not populate. That
 *   is indistinguishable from a typo in the action string.
 *
 *   v4 does not consult that registry at all: in 4.0 the action is an input to
 *   the proof rather than a registered entity. Per-credential outcomes come
 *   back in `results[]`.
 *
 * A consequence worth noting: because v4 skips the registry, the
 * `max_verifications` cap that a v2 incognito action carries is not enforced on
 * this path — so a continuity gate re-verifying the same nullifier repeatedly
 * is fine. On v2 that same pattern would jam on `already_verified`.
 *
 * `preflight.ts` still probes v2 as a diagnostic, to show which gate is closed.
 * Nothing sends a real proof there.
 */

export function clampMaxAge(seconds: number | null | undefined): number | null {
  if (seconds == null) return null;
  return Math.min(MAX_AGE_MAX_SECONDS, Math.max(MAX_AGE_MIN_SECONDS, seconds));
}

/** Per-credential result inside a v4 response. */
type V4Result = {
  identifier: string;
  success: boolean;
  code?: string;
  detail?: string;
};

type V4Response = {
  success: boolean;
  code?: string;
  detail?: string;
  results?: V4Result[];
  nullifier?: string;
  action?: string;
  created_at?: string;
  environment?: string;
};

export type VerifyAttempt = {
  target: "v4";
  url: string;
  request: Record<string, unknown>;
  status: number;
  response: V4Response;
  /** Normalized outcome. */
  ok: boolean;
  code?: string;
  guidance?: string;
};

/**
 * The error codes both endpoints emit, translated into what to actually do.
 * Several of these are absent from the published error lists.
 */
const VERIFY_GUIDANCE: Record<string, string> = {
  invalid_action:
    "The v2 legacy endpoint could not resolve this action. If the app completed World ID 4.0 RP registration, this is expected for every action — verify via /api/v4/verify/{rp_id} instead.",
  invalid_merkle_root:
    "Merkle root not recognized — the credential looks unverified, or the proof came from a different environment than the one being verified against (sandbox vs production).",
  invalid_proof:
    "Proof rejected. Check that `nullifier_hash` (not `nullifier`) is sent on v2, and that the action matches the one the proof was minted for.",
  root_too_old: "The proof's merkle root is stale. Have the user re-run the check.",
  already_verified:
    "This nullifier already verified this action and the action caps verifications. Continuity needs unlimited re-verification — v4 does not enforce this cap, so prefer v4.",
  exceeded_max_verifications:
    "The action's verification cap is exhausted. Continuity requires unlimited re-verification; v4 does not apply the cap.",
  all_verifications_failed:
    "Every credential in the request failed. See `results[]` for the per-credential reason.",
  rp_not_active:
    "RP registration is not active. Finish it in the Developer Portal before signing requests.",
  app_not_migrated:
    "This app has not completed RP registration, so v4 cannot serve it. Use /api/v2/verify/{app_id}.",
  world_id_4_not_available:
    "World App on this device predates World ID 4.0. Do NOT silently retry with allow_legacy_proofs: true — accepting both versions gives one human two different nullifiers, which defeats any gate keyed on a single nullifier. Ask the user to update World App.",
  integrity_verification_failed:
    "The result's `integrity_bundle` was missing, or its version is not the one Selfie Check 4.0 requires (version 2). The bundle is device-attested by World App and cannot be produced server-side, so this cannot be worked around — forward it from the IDKit result verbatim, and if the version is wrong the World App build cannot satisfy this endpoint.",
  invalid_schema_id:
    "`issuer_schema_id` did not match the requested credential (Selfie Check is 11, proof_of_human is 1). Only 4.0 proofs carry this field.",
};

export function verifyGuidance(code?: string): string | undefined {
  return code ? VERIFY_GUIDANCE[code] : undefined;
}

export type VerifyArgs = {
  config: SelfieCheckConfig;
  item: ResponseItemV3;
  action: string;
  /** rp_context nonce the proof was minted against (required by v4). */
  nonce: string;
  maxAgeSeconds?: number | null;
};

export async function verifySelfieProof(
  args: VerifyArgs,
): Promise<VerifyAttempt> {
  return verifyV4(args);
}

async function verifyV4(args: VerifyArgs): Promise<VerifyAttempt> {
  const { config, item, action, nonce } = args;
  const url = `${config.portal}/api/v4/verify/${config.rpId}`;

  // Forward the response item THROUGH rather than rebuilding it from the
  // fields these types know about. This is World's own guidance ("No longer
  // reshape the payload ... for the verify endpoint", /world-id/4-0-migration),
  // and it is what lets a field newer than these types still reach the
  // endpoint.
  //
  // v4 accepts a legacy 3.0 proof, which is what Selfie Check emits: a single
  // `proof` string plus a separate `merkle_root`, and no `issuer_schema_id`.
  const body: Record<string, unknown> = {
    protocol_version: "3.0",
    nonce,
    action,
    // The endpoint's enum is production | staging only. Sending it explicitly
    // rather than relying on the default keeps the mint/verify pair visible in
    // the request the inspector shows, instead of hiding it in a default.
    environment: config.verifiableEnvironment,
    responses: [{ ...item }],
  };

  const { status, json } = await post(url, body);
  const res = json as V4Response;

  // v4 reports outcomes PER CREDENTIAL, and a partial success is still HTTP 200
  // with a truthy top-level `success` ("at least one proof verified"). Trusting
  // that flag would accept a request whose Selfie Check credential actually
  // failed, so require the selfie entry itself to have succeeded.
  const selfie = res.results?.find((r) => isSelfieIdentifier(r.identifier));
  const selfieOk = selfie ? selfie.success === true : res.success === true;
  const ok = res.success === true && selfieOk;

  const code = selfie?.code ?? res.code;
  const guidance = ok
    ? undefined
    : res.success === true && selfie && selfie.success !== true
      ? `Partial success: the response was HTTP 200 with success: true, but the "${selfie.identifier}" credential failed (${selfie.code ?? "no code"}). Rejecting. Always inspect results[] per identifier.`
      : verifyGuidance(code);

  return {
    target: "v4",
    url,
    request: redact(body, item.proof),
    status,
    response: res,
    ok,
    code,
    guidance,
  };
}

async function post(url: string, body: unknown) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
    cache: "no-store",
  });
  const json = await res.json().catch(() => ({
    success: false,
    code: "unexpected_response",
    detail: `Endpoint returned ${res.status} with a non-JSON body.`,
  }));
  return { status: res.status, json };
}

/** Keep the full proof out of logs and out of the client inspector. */
function redact(body: Record<string, unknown>, proof: string) {
  const short = `${proof.slice(0, 18)}… (truncated)`;
  const out: Record<string, unknown> = { ...body };
  if (Array.isArray(out.responses)) {
    out.responses = (out.responses as Record<string, unknown>[]).map((r) => ({
      ...r,
      proof: short,
    }));
  }
  return out;
}

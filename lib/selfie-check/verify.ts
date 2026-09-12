import "server-only";

import { DEVELOPER_PORTAL, type SelfieCheckConfig } from "./config";
import {
  MAX_AGE_MAX_SECONDS,
  MAX_AGE_MIN_SECONDS,
  SELFIE_VERIFICATION_LEVEL,
  isSelfieIdentifier,
  type ResponseItemV3,
  type VerifyResponse,
} from "./types";

/**
 * Server-side proof verification against the Developer Portal.
 *
 * There are TWO endpoints and picking the wrong one wastes a lot of time,
 * because the failure looks like a configuration problem rather than a routing
 * one. Measured against a real RP-registered app:
 *
 *   POST /api/v2/verify/{app_id}   — legacy. Resolves the action against a
 *     pre-registered action registry FIRST. On an app that completed World ID
 *     4.0 RP registration it answers `invalid_action` for every action —
 *     including one that visibly exists in the portal — because it reads a
 *     registry this app doesn't populate. Indistinguishable from a typo.
 *
 *   POST /api/v4/verify/{rp_id}    — current. Accepts legacy 3.0 proofs (which
 *     is all Selfie Check emits) and does NOT consult an action registry at
 *     all: an unregistered action name reaches proof verification just the same,
 *     since in 4.0 the action is an input to the proof rather than a registered
 *     entity. Per-credential outcomes come back in `results[]`.
 *
 * So: v4 keyed by rp_id is the path for Selfie Check. v2 is kept only for apps
 * that never migrated.
 *
 * A consequence worth noting: because v4 skips the action registry, the
 * `max_verifications` cap that a v2 incognito action carries is not enforced on
 * this path — so a continuity gate re-verifying the same nullifier repeatedly is
 * fine. On v2 that same pattern would jam on `already_verified`.
 */

export type VerifyTarget = "v4" | "v2";

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
  target: VerifyTarget;
  url: string;
  request: Record<string, unknown>;
  status: number;
  response: VerifyResponse | V4Response;
  /** Normalized outcome, so callers don't branch on endpoint shape. */
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
};

export function verifyGuidance(code?: string): string | undefined {
  return code ? VERIFY_GUIDANCE[code] : undefined;
}

export type VerifyArgs = {
  config: Extract<SelfieCheckConfig, { mode: "live" }>;
  item: ResponseItemV3;
  action: string;
  /** rp_context nonce the proof was minted against (required by v4). */
  nonce: string;
  maxAgeSeconds?: number | null;
  /** Defaults to v4, which is correct for any RP-registered app. */
  target?: VerifyTarget;
};

export async function verifySelfieProof(
  args: VerifyArgs,
): Promise<VerifyAttempt> {
  const target = args.target ?? "v4";
  return target === "v4" ? verifyV4(args) : verifyV2(args);
}

async function verifyV4(args: VerifyArgs): Promise<VerifyAttempt> {
  const { config, item, action, nonce } = args;
  const url = `${DEVELOPER_PORTAL}/api/v4/verify/${config.rpId}`;

  const body: Record<string, unknown> = {
    protocol_version: "3.0",
    nonce,
    action,
    responses: [
      {
        identifier: item.identifier,
        proof: item.proof,
        merkle_root: item.merkle_root,
        nullifier: item.nullifier,
        ...(item.signal_hash ? { signal_hash: item.signal_hash } : {}),
      },
    ],
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

async function verifyV2(args: VerifyArgs): Promise<VerifyAttempt> {
  const { config, item, action } = args;
  const maxAge = clampMaxAge(args.maxAgeSeconds);
  const url = `${DEVELOPER_PORTAL}/api/v2/verify/${config.appId}`;

  const body: Record<string, unknown> = {
    // v2 renames this field — passing IDKit's `nullifier` through fails with
    // `invalid_proof` and no hint about which field was wrong.
    nullifier_hash: item.nullifier,
    proof: item.proof,
    merkle_root: item.merkle_root,
    verification_level: SELFIE_VERIFICATION_LEVEL,
    action,
  };
  if (item.signal_hash) body.signal_hash = item.signal_hash;
  if (maxAge != null) body.max_age = maxAge;

  const { status, json } = await post(url, body);
  const res = json as VerifyResponse;

  return {
    target: "v2",
    url,
    request: redact(body, item.proof),
    status,
    response: res,
    ok: res.success === true,
    code: res.success ? undefined : String(res.code),
    guidance: res.success ? undefined : verifyGuidance(String(res.code)),
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
  const out: Record<string, unknown> = { ...body, proof: short };
  if (Array.isArray(out.responses)) {
    out.responses = (out.responses as Record<string, unknown>[]).map((r) => ({
      ...r,
      proof: short,
    }));
    delete out.proof;
  }
  return out;
}

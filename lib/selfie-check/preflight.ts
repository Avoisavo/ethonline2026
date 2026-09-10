import "server-only";

import { DEVELOPER_PORTAL, getConfig } from "./config";
import { SELFIE_VERIFICATION_LEVEL } from "./types";

/**
 * Preflight the live integration.
 *
 * Selfie Check has four independent gates and only the first is self-service.
 * Failing any of the others surfaces as a cryptic code much later — at World App
 * (`inactive_rp`, `feature_unavailable`) or at the verify endpoint
 * (`invalid_action`), with nothing pointing at the actual cause. This probes
 * what can be probed server-side and names the fix.
 *
 * The probes deliberately send an all-zero proof. Verification fails either
 * way; what matters is *which* error comes back, because the endpoint checks
 * app, action and RP registration before it ever looks at the proof.
 */

export type PreflightStatus = "ok" | "blocked" | "unknown";

export type PreflightCheck = {
  id: string;
  label: string;
  status: PreflightStatus;
  detail: string;
  /** Concrete next step when blocked. */
  fix?: string;
  /** Raw code the API returned, when there was one. */
  code?: string;
};

const ZERO = `0x${"00".repeat(32)}`;
const FAKE_PROOF = `0x${"11".repeat(256)}`;

async function postJson(url: string, body: unknown) {
  try {
    const res = await fetch(url, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      cache: "no-store",
    });
    const json = (await res.json().catch(() => ({}))) as {
      code?: string;
      detail?: string;
    };
    return { status: res.status, code: json.code, detail: json.detail };
  } catch (err) {
    return {
      status: 0,
      code: "network_error",
      detail: err instanceof Error ? err.message : String(err),
    };
  }
}

export async function preflight(): Promise<{
  mode: "live" | "mock";
  checks: PreflightCheck[];
}> {
  const config = getConfig();
  const checks: PreflightCheck[] = [];

  if (config.mode === "mock") {
    checks.push({
      id: "env",
      label: "Credentials",
      status: "blocked",
      detail: `Missing ${config.missing.join(", ")}.`,
      fix: "Add them to .env.local and restart the dev server.",
    });
    return { mode: "mock", checks };
  }

  checks.push({
    id: "env",
    label: "Credentials",
    status: "ok",
    detail: `app_id, rp_id and signing key loaded. action="${config.action}".`,
  });

  // 1. Can we actually produce an RP signature with this key?
  try {
    const { signRequest } = await import("@worldcoin/idkit/signing");
    const signed = signRequest({
      signingKeyHex: config.signingKey,
      action: config.action,
      ttl: 300,
    });
    const bytes = (signed.sig.length - 2) / 2;
    checks.push({
      id: "signing",
      label: "RP signature",
      status: bytes === 65 ? "ok" : "blocked",
      detail:
        bytes === 65
          ? "Signing key produces a valid 65-byte r|s|v signature."
          : `Produced ${bytes} bytes, expected 65.`,
      fix: bytes === 65 ? undefined : "Re-copy the signing key from the portal.",
    });
  } catch (err) {
    checks.push({
      id: "signing",
      label: "RP signature",
      status: "blocked",
      detail: err instanceof Error ? err.message : String(err),
      fix: "WORLD_RP_SIGNING_KEY must be 0x + 64 hex characters.",
    });
  }

  // 2. Does the app + action exist? The v2 endpoint resolves both before it
  //    looks at the proof, so the error code tells us which one is missing.
  const v2 = await postJson(
    `${DEVELOPER_PORTAL}/api/v2/verify/${config.appId}`,
    {
      nullifier_hash: ZERO,
      proof: FAKE_PROOF,
      merkle_root: ZERO,
      verification_level: SELFIE_VERIFICATION_LEVEL,
      action: config.action,
    },
  );

  if (v2.code === "invalid_action") {
    checks.push({
      id: "action",
      label: "Action registered",
      status: "blocked",
      code: v2.code,
      detail: `app_id resolves, but the action "${config.action}" does not exist on it.`,
      fix: `Create an incognito action named "${config.action}" in the Developer Portal.`,
    });
  } else if (
    v2.code === "invalid_proof" ||
    v2.code === "invalid_merkle_root" ||
    v2.code === "root_too_old"
  ) {
    // Reaching proof validation means app and action both resolved.
    checks.push({
      id: "action",
      label: "Action registered",
      status: "ok",
      code: v2.code,
      detail: `app_id and action "${config.action}" both resolve — the endpoint got as far as validating the proof.`,
    });
  } else {
    checks.push({
      id: "action",
      label: "Action registered",
      status: "unknown",
      code: v2.code,
      detail:
        v2.detail ?? `Unexpected response from the verify endpoint (${v2.status}).`,
      fix: "Check the app_id and action in the Developer Portal.",
    });
  }

  // 3. Is RP registration active? IDKit requires a signed rp_context, and an
  //    inactive RP is rejected by World App as `inactive_rp` / `unknown_rp`.
  const v4 = await postJson(`${DEVELOPER_PORTAL}/api/v4/verify/${config.rpId}`, {
    protocol_version: "3.0",
    nonce: ZERO,
    action: config.action,
    responses: [
      {
        identifier: SELFIE_VERIFICATION_LEVEL,
        proof: FAKE_PROOF,
        merkle_root: ZERO,
        nullifier: ZERO,
      },
    ],
  });

  if (v4.code === "rp_not_active") {
    checks.push({
      id: "rp",
      label: "RP registration active",
      status: "blocked",
      code: v4.code,
      detail: "rp_id exists but its registration is not active.",
      fix: "Finish RP registration in the Developer Portal (the Enable World ID 4.0 banner). Until it is active, World App rejects the request with inactive_rp.",
    });
  } else {
    checks.push({
      id: "rp",
      label: "RP registration active",
      status: v4.code === "network_error" ? "unknown" : "ok",
      code: v4.code,
      detail:
        v4.code === "network_error"
          ? "Could not reach the verify endpoint."
          : "RP registration resolves.",
    });
  }

  // 4. The beta flag cannot be probed from the server — only World App knows.
  checks.push({
    id: "selfie_flag",
    label: "Selfie Check enabled",
    status: "unknown",
    detail:
      "Not visible server-side. World App reports it as feature_unavailable on the first real request.",
    fix: "Request the Selfie Check beta flag for this app_id via your World contact.",
  });

  return { mode: "live", checks };
}

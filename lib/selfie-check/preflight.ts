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

  // 1b. Does the signing key correspond to the signer address the portal
  //     registered? This is the highest-value check available: a wrong or
  //     rotated key surfaces ONLY as `invalid_rp_signature` from World App,
  //     which is indistinguishable from a bad message layout or the classic
  //     SHA3-vs-Keccak mistake. Deriving the address settles it locally.
  try {
    const secp = await import("@noble/secp256k1");
    const { keccak_256 } = await import("@noble/hashes/sha3.js");

    const pub = secp.getPublicKey(config.signingKey.replace(/^0x/, ""), false);
    const derived = `0x${Buffer.from(keccak_256(pub.slice(1)).slice(-20)).toString("hex")}`;
    const expected = process.env.WORLD_RP_SIGNER_ADDRESS;

    if (expected) {
      const match = derived.toLowerCase() === expected.toLowerCase();
      checks.push({
        id: "signer",
        label: "Signer address matches portal",
        status: match ? "ok" : "blocked",
        detail: match
          ? `Signing key derives to ${expected}, the address registered for this RP.`
          : `Key derives to ${derived}, but the portal has ${expected}.`,
        fix: match
          ? undefined
          : "The key was rotated or copied from another app. Re-copy it from World ID Configuration.",
      });
    } else {
      checks.push({
        id: "signer",
        label: "Signer address",
        status: "unknown",
        detail: `Signing key derives to ${derived}.`,
        fix: "Set WORLD_RP_SIGNER_ADDRESS to the Signer address shown in World ID Configuration and this becomes an automatic check.",
      });
    }
  } catch (err) {
    checks.push({
      id: "signer",
      label: "Signer address",
      status: "unknown",
      detail: err instanceof Error ? err.message : String(err),
    });
  }

  // 2. Is the v4 endpoint reachable and the RP registration active? This is
  //    the endpoint that actually matters: v4 accepts the legacy 3.0 proofs
  //    Selfie Check emits, keyed by rp_id.
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
      label: "Verify endpoint (v4)",
      status: "blocked",
      code: v4.code,
      detail: "rp_id exists but its registration is not active.",
      fix: "Finish RP registration in the Developer Portal (the Enable World ID 4.0 banner). Until it is active, World App rejects requests with inactive_rp.",
    });
  } else if (v4.code === "all_verifications_failed") {
    // The deliberately bogus proof got all the way to cryptographic
    // verification, which means endpoint, rp_id and RP registration are fine.
    checks.push({
      id: "rp",
      label: "Verify endpoint (v4)",
      status: "ok",
      code: v4.code,
      detail:
        "RP registration active and the endpoint reaches proof verification — the test proof was rejected on its merkle root, as expected.",
    });
  } else if (v4.code === "app_not_migrated") {
    checks.push({
      id: "rp",
      label: "Verify endpoint (v4)",
      status: "blocked",
      code: v4.code,
      detail: "This app has not completed RP registration, so v4 cannot serve it.",
      fix: "Complete RP registration, or set the verify target to v2.",
    });
  } else {
    checks.push({
      id: "rp",
      label: "Verify endpoint (v4)",
      status: "unknown",
      code: v4.code,
      detail: v4.detail ?? `Unexpected response (${v4.status}).`,
    });
  }

  // 3. The v2 legacy registry. Measured behaviour: on an RP-registered app, v2
  //    answers `invalid_action` for EVERY action, including one that plainly
  //    exists in the portal — it reads a registry this app doesn't populate.
  //    That is not a misconfiguration, so report it as information, not a
  //    blocker. It only matters if something still points at v2.
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

  checks.push({
    id: "v2",
    label: "Legacy v2 endpoint",
    status: "ok",
    code: v2.code,
    detail:
      v2.code === "invalid_action"
        ? "Returns invalid_action for every action on an RP-registered app — expected, and not used. Verification goes through v4."
        : `Responds with ${v2.code ?? v2.status}. Not used; verification goes through v4.`,
  });

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

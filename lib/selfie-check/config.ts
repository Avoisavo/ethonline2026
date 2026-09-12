import "server-only";

/**
 * Live configuration for the Selfie Check integration.
 *
 * There is no mock mode and no fallback. Every value comes from the
 * environment and is validated here; if anything is missing or malformed the
 * app says which variable and how to fix it rather than degrading into a state
 * that looks like it works.
 *
 * Two of these deserve the explicit treatment they get below:
 *
 *   WORLD_ACTION has no default. Nullifiers are scoped per action, so a silent
 *   default is worse than an error: point two deployments at different actions
 *   and every returning user reads as a brand-new human, with nothing failing.
 *
 *   WORLD_ENVIRONMENT is required rather than assumed. IDKit accepts
 *   production | staging | sandbox and defaults to production, but the verify
 *   endpoint's own `environment` enum is only production | staging — "sandbox"
 *   has no value to be verified under. Minting in one environment and verifying
 *   in another surfaces only as `invalid_merkle_root`, which reads as an
 *   unverified credential and sends you to re-enroll the user. Making the
 *   choice explicit is the only way to keep the two halves aligned on purpose.
 */

/**
 * The only protocol version this app speaks.
 *
 * 3.0, via the `selfieCheckLegacy()` preset with `allow_legacy_proofs: true`.
 *
 * Not a preference — it is the only version Selfie Check is issuable on. The
 * credential IS in the 4.0 union, and `CredentialRequest("selfie")` builds a
 * valid 4.0 request, but on a real device that request returns
 * `credential_unavailable`: World App holds no 4.0 selfie credential to
 * present. Verified the same day that the 3.0 route returned HTTP 200 for the
 * same human on the same app.
 *
 * Pinning one version is a correctness requirement, not a preference. A human's
 * 3.0 and 4.0 nullifiers are different, unlinkable values, so accepting both
 * would let one person hold two anchors — enroll on one version, present the
 * other, and read as a different human with nothing failing. This is a code
 * constant rather than an env var precisely so it cannot be widened by
 * configuration.
 *
 * What 4.0 would buy if it were issuable: an RP-scoped rather than
 * action-scoped nullifier, and `issuer_schema_id` (11) on the response — the
 * only field that can prove WHICH credential produced a proof. On 3.0 that
 * evidence does not exist, so the identifier string is all there is, and the
 * action string must never be rotated.
 */
export const PROOF_VERSION = "3.0" as const;
export type ProofVersion = typeof PROOF_VERSION;

/** Environments IDKit will mint a proof against. */
export const ENVIRONMENTS = ["production", "staging", "sandbox"] as const;
export type Environment = (typeof ENVIRONMENTS)[number];

/**
 * Environments the v4 verify endpoint documents an `environment` value for.
 * "sandbox" is absent, which is why `verifiableEnvironment` exists below.
 */
export const VERIFIABLE_ENVIRONMENTS = ["production", "staging"] as const;

export type SelfieCheckConfig = {
  appId: `app_${string}`;
  rpId: `rp_${string}`;
  /** Never leaves the server. */
  signingKey: string;
  action: string;
  /** What IDKit mints against. */
  environment: Environment;
  /** Always PROOF_VERSION. Carried on the config so callers need not import it. */
  proofVersion: ProofVersion;
  /**
   * What the verify request declares. `sandbox` has no counterpart in the
   * endpoint's enum, so it resolves to the endpoint default and is reported as
   * a known asymmetry rather than silently coerced.
   */
  verifiableEnvironment: (typeof VERIFIABLE_ENVIRONMENTS)[number];
  portal: string;
  /** Optional cross-check: the "Signer address" from World ID Configuration. */
  signerAddress: string | null;
};

export type ConfigProblem = {
  name: string;
  issue: string;
  fix: string;
};

export type ConfigResult =
  | { ok: true; config: SelfieCheckConfig }
  | { ok: false; problems: ConfigProblem[] };

/**
 * Default Developer Portal origin. Overridable with WORLD_PORTAL_URL so the
 * host is not welded into the code, but it is a stable published origin rather
 * than per-deployment configuration, so it does not need to be set.
 */
const DEFAULT_PORTAL = "https://developer.world.org";

function readPortal(): string {
  const raw = process.env.WORLD_PORTAL_URL?.trim();
  if (!raw) return DEFAULT_PORTAL;
  return raw.replace(/\/+$/, "");
}

export function getConfig(): ConfigResult {
  const problems: ConfigProblem[] = [];

  const appId = process.env.WORLD_APP_ID?.trim();
  const rpId = process.env.WORLD_RP_ID?.trim();
  const signingKey = process.env.WORLD_RP_SIGNING_KEY?.trim();
  const action = process.env.WORLD_ACTION?.trim();
  const environment = process.env.WORLD_ENVIRONMENT?.trim();
  const signerAddress = process.env.WORLD_RP_SIGNER_ADDRESS?.trim() || null;

  if (!appId) {
    problems.push({
      name: "WORLD_APP_ID",
      issue: "Not set.",
      fix: "Copy the App ID from your app's overview in the Developer Portal.",
    });
  } else if (!appId.startsWith("app_")) {
    problems.push({
      name: "WORLD_APP_ID",
      issue: `Must start with "app_", got "${appId.slice(0, 12)}…".`,
      fix: "Copy the App ID, not the app name or the RP ID.",
    });
  }

  if (!rpId) {
    problems.push({
      name: "WORLD_RP_ID",
      issue: "Not set.",
      fix: "Take it from World ID Configuration after RP registration is active.",
    });
  } else if (!rpId.startsWith("rp_")) {
    // The SDK types rp_id as a bare string, so the prefix rule only surfaces at
    // runtime from inside the WASM bridge ("Invalid RP ID: must start with rp_").
    problems.push({
      name: "WORLD_RP_ID",
      issue: `Must start with "rp_", got "${rpId.slice(0, 12)}…".`,
      fix: "Copy the RP ID from World ID Configuration, not the App ID.",
    });
  }

  if (!signingKey) {
    problems.push({
      name: "WORLD_RP_SIGNING_KEY",
      issue: "Not set.",
      fix: "Copy the RP signing key from World ID Configuration. Server-side only — never prefix it with NEXT_PUBLIC_.",
    });
  } else if (!/^0x[0-9a-fA-F]{64}$/.test(signingKey)) {
    problems.push({
      name: "WORLD_RP_SIGNING_KEY",
      issue: "Must be 0x followed by 64 hex characters (a 32-byte secp256k1 key).",
      fix: "Re-copy the key from the portal; a truncated paste fails only as invalid_rp_signature.",
    });
  }

  if (!action) {
    problems.push({
      name: "WORLD_ACTION",
      issue: "Not set. There is deliberately no default.",
      fix: 'Set a stable action string (e.g. "continuity-gate") and never change it — nullifiers are scoped per action, so rotating it silently resets every user\'s identity.',
    });
  }

  let env: Environment | null = null;
  if (!environment) {
    problems.push({
      name: "WORLD_ENVIRONMENT",
      issue: "Not set. There is deliberately no default.",
      fix: `One of ${ENVIRONMENTS.join(" | ")}. It must match the environment your app_id and rp_id are registered in, or proofs fail as invalid_merkle_root.`,
    });
  } else if (!(ENVIRONMENTS as readonly string[]).includes(environment)) {
    problems.push({
      name: "WORLD_ENVIRONMENT",
      issue: `"${environment}" is not a valid environment.`,
      fix: `One of ${ENVIRONMENTS.join(" | ")}.`,
    });
  } else {
    env = environment as Environment;
  }

  if (signerAddress && !/^0x[0-9a-fA-F]{40}$/.test(signerAddress)) {
    problems.push({
      name: "WORLD_RP_SIGNER_ADDRESS",
      issue: "Must be a 0x-prefixed 20-byte address.",
      fix: 'Copy the "Signer address" field from World ID Configuration, or unset it.',
    });
  }

  if (problems.length > 0) return { ok: false, problems };

  return {
    ok: true,
    config: {
      appId: appId as `app_${string}`,
      rpId: rpId as `rp_${string}`,
      signingKey: signingKey!,
      action: action!,
      environment: env!,
      proofVersion: PROOF_VERSION,
      // sandbox has no verify-side value; it resolves to the endpoint default.
      verifiableEnvironment: env === "staging" ? "staging" : "production",
      portal: readPortal(),
      signerAddress,
    },
  };
}

/** For routes that cannot do anything useful without a valid configuration. */
export function requireConfig(): SelfieCheckConfig {
  const result = getConfig();
  if (!result.ok) {
    throw new ConfigError(result.problems);
  }
  return result.config;
}

export class ConfigError extends Error {
  readonly problems: ConfigProblem[];
  constructor(problems: ConfigProblem[]) {
    super(
      `Selfie Check is not configured: ${problems.map((p) => p.name).join(", ")}`,
    );
    this.name = "ConfigError";
    this.problems = problems;
  }
}

/** True when the mint environment has no verify-side counterpart. */
export function environmentAsymmetry(config: SelfieCheckConfig): string | null {
  if (config.environment !== "sandbox") return null;
  return 'WORLD_ENVIRONMENT is "sandbox", but the v4 verify endpoint\'s environment enum is production | staging only — the request carries no sandbox value, so verification resolves to the endpoint default. If proofs fail as invalid_merkle_root, this asymmetry is the first thing to rule out.';
}

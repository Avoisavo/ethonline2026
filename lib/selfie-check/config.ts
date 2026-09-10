import "server-only";

/**
 * Selfie Check is an access-gated beta, so this demo runs in one of two modes.
 *
 * - `live`   — real IDKit widget, real rp_context signatures, real verify call.
 *              Requires all four env vars below.
 * - `mock`   — a local proof engine that emits the same World ID 3.0 payload
 *              shape. Lets the whole continuity flow be exercised (and every
 *              World App error code reproduced) before beta access lands.
 *
 * Set these in `.env.local` to switch to live mode — no code change needed:
 *   WORLD_APP_ID=app_...
 *   WORLD_RP_ID=rp_...
 *   WORLD_RP_SIGNING_KEY=0x...     (never exposed to the client)
 *   WORLD_ACTION=continuity-gate
 */

export type DemoMode = "live" | "mock";

export type SelfieCheckConfig =
  | {
      mode: "live";
      appId: `app_${string}`;
      rpId: string;
      signingKey: string;
      action: string;
    }
  | { mode: "mock"; action: string; missing: string[] };

/** Stable action string. Must not rotate — see `policy.ts` for why. */
const DEFAULT_ACTION = "continuity-gate";

export function getConfig(): SelfieCheckConfig {
  const action = process.env.WORLD_ACTION || DEFAULT_ACTION;
  const appId = process.env.WORLD_APP_ID;
  const rpId = process.env.WORLD_RP_ID;
  const signingKey = process.env.WORLD_RP_SIGNING_KEY;

  const missing = [
    !appId && "WORLD_APP_ID",
    !rpId && "WORLD_RP_ID",
    !signingKey && "WORLD_RP_SIGNING_KEY",
  ].filter((v): v is string => typeof v === "string");

  if (missing.length > 0 || !appId?.startsWith("app_")) {
    return {
      mode: "mock",
      action,
      missing: missing.length > 0 ? missing : ["WORLD_APP_ID (must start with app_)"],
    };
  }

  return {
    mode: "live",
    appId: appId as `app_${string}`,
    rpId: rpId!,
    signingKey: signingKey!,
    action,
  };
}

/** Base URL for the Developer Portal verify API. */
export const DEVELOPER_PORTAL = "https://developer.world.org";

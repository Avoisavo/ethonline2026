"use client";

import { IDKitRequestWidget, selfieCheckLegacy } from "@worldcoin/idkit";
import type { IDKitResult, RpContext } from "@worldcoin/idkit";

/**
 * The real Selfie Check request. World ID 3.0, via the legacy preset.
 *
 * `selfieCheckLegacy()` is a *preset* whose JSDoc says it "only returns World
 * ID 3.0 proofs" — a property of the preset, not of the credential. The
 * credential is also in the 4.0 union
 * (`"proof_of_human" | "selfie" | "passport" | "mnc"`), so
 * `CredentialRequest("selfie")` builds a valid 4.0 request. It just cannot be
 * satisfied: on a real device that route returns `credential_unavailable`,
 * because World App holds no 4.0 selfie credential to present. Verified the
 * same day this 3.0 route returned HTTP 200 for the same human. Neither the
 * credential page nor the sandbox page mentions protocol versions at all, so
 * there is nothing in the docs that would have predicted this.
 *
 * `allow_legacy_proofs` is REQUIRED by `IDKitRequestConfig` (no `?`, no
 * default) and must be `true` here — with `false` the request would have
 * nothing valid to return, since the preset only produces 3.0. Note the
 * trade-off its own doc comment describes: true means "accept both v3 and v4
 * ... you must track both v3 and v4 nullifiers to prevent double-claims". The
 * server closes that by rejecting any non-3.0 result outright, so only one
 * nullifier space is ever anchored.
 *
 * `environment` comes from WORLD_ENVIRONMENT and is never hardcoded. It selects
 * the World App connect base URL (world.org / staging.world.org /
 * sandbox.world.org), so it decides whether the phone can complete the hand-off
 * at all. "sandbox" needs the separate TestFlight / private-Play sandbox build —
 * the public World App is a production client, so pointing a production app at
 * the sandbox URL is not a sandbox test.
 *
 * `rp_context` is minted server-side per attempt and lives 300s. Reusing one
 * surfaces as `rp_signature_expired` or `duplicate_nonce`.
 */
export default function LiveSelfieCheck({
  appId,
  action,
  rpContext,
  signal,
  environment,
  open,
  onOpenChange,
  onResult,
  onFailure,
}: {
  appId: `app_${string}`;
  action: string;
  rpContext: RpContext;
  signal: string;
  environment: "production" | "staging" | "sandbox";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResult: (result: IDKitResult) => void;
  onFailure: (code: string) => void;
}) {
  return (
    <IDKitRequestWidget
      open={open}
      onOpenChange={onOpenChange}
      app_id={appId}
      action={action}
      rp_context={rpContext}
      environment={environment}
      allow_legacy_proofs
      preset={selfieCheckLegacy({ signal })}
      onSuccess={onResult}
      onError={(code) => onFailure(String(code))}
    />
  );
}

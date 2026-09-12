"use client";

import { CredentialRequest, IDKitRequestWidget } from "@worldcoin/idkit";
import type { IDKitResult, RpContext } from "@worldcoin/idkit";

import { SELFIE_IDENTIFIER } from "@/lib/selfie-check/types";

/**
 * The real Selfie Check request, used when live credentials are configured.
 *
 * This requests a World ID **4.0** proof. Worth spelling out why, because the
 * obvious reading of the SDK points the other way:
 *
 * 1. Selfie Check is available on both protocol versions. `selfieCheckLegacy()`
 *    is a *preset* whose JSDoc says "This preset only returns World ID 3.0
 *    proofs" — that is a property of the preset, not of the credential. The
 *    credential itself is in the 4.0 union:
 *      type CredentialType = "proof_of_human" | "selfie" | "passport" | "mnc"
 *    so `CredentialRequest("selfie")` is the 4.0 route. Neither the credential
 *    page nor the sandbox page mentions either route.
 *
 * 2. `preset` and `constraints` are mutually exclusive on the widget
 *    (IDKitRequestHookConfig is a `preset XOR constraints` union), so moving to
 *    4.0 means dropping `preset` entirely rather than adding to it.
 *
 * 3. `allow_legacy_proofs` is REQUIRED by `IDKitRequestConfig` (no `?`, no
 *    default) and is `false` here. Its own doc comment is the reason:
 *      true  — accept both v3 and v4. "You must track both v3 and v4
 *              nullifiers to prevent double-claims."
 *      false — only accept v4. "Use after migration cutoff or for new apps."
 *    Accepting both would hand one human two different nullifiers, so any
 *    uniqueness or continuity gate keyed on a single nullifier column could be
 *    satisfied twice. Pinning one protocol version is what makes the anchor
 *    comparison sound.
 *
 * 4. The 4.0 nullifier is RP-scoped rather than action-scoped, which is a
 *    stronger primitive for continuity: it does not silently reset if the
 *    action string is ever changed.
 *
 * 5. `rp_context` must be minted server-side per request and is short-lived
 *    (300s default TTL). Reusing one across attempts surfaces as
 *    `rp_signature_expired` or `duplicate_nonce`.
 *
 * If World App reports `world_id_4_not_available`, the device is on a build
 * that predates 4.0 — `face-console.tsx` surfaces that code as-is rather than
 * silently falling back, because a silent fallback to 3.0 would reintroduce the
 * two-nullifiers-per-human problem in (3).
 */
export default function LiveSelfieCheck({
  appId,
  action,
  rpContext,
  signal,
  open,
  onOpenChange,
  onResult,
  onFailure,
}: {
  appId: `app_${string}`;
  action: string;
  rpContext: RpContext;
  signal: string;
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
      allow_legacy_proofs={false}
      environment="sandbox"
      constraints={CredentialRequest(SELFIE_IDENTIFIER, { signal })}
      onSuccess={onResult}
      onError={(code) => onFailure(String(code))}
    />
  );
}

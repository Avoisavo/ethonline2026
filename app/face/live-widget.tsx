"use client";

import {
  CredentialRequest,
  IDKitRequestWidget,
  selfieCheckLegacy,
} from "@worldcoin/idkit";
import type { IDKitResult, RpContext } from "@worldcoin/idkit";

import { SELFIE_IDENTIFIER } from "@/lib/selfie-check/types";

/**
 * The real Selfie Check request.
 *
 * Both protocol versions are supported, chosen by WORLD_PROOF_VERSION, and
 * exactly one is accepted per deployment. The server pins the same value, so a
 * client cannot pick the other one — a human's 3.0 and 4.0 nullifiers are
 * different, unlinkable values, and accepting both would let one person hold
 * two anchors.
 *
 * The two shapes are mutually exclusive at the type level:
 * `IDKitRequestHookConfig` is a `preset XOR constraints` union, so this cannot
 * be expressed as one element with a conditional prop — hence two branches.
 *
 *   3.0 — `selfieCheckLegacy()` as `preset`, `allow_legacy_proofs: true`.
 *         The preset's JSDoc says it "only returns World ID 3.0 proofs", which
 *         is why `false` cannot work here: the request would have nothing valid
 *         to return.
 *   4.0 — `CredentialRequest("selfie")` as `constraints`,
 *         `allow_legacy_proofs: false`. "selfie" is in the 4.0 credential union
 *         (`"proof_of_human" | "selfie" | "passport" | "mnc"`), so the
 *         credential is available on both versions — it is the *preset* that is
 *         3.0-only, not the credential. Neither the credential page nor the
 *         sandbox page documents either route.
 *
 * `environment` comes from WORLD_ENVIRONMENT and is never hardcoded. It selects
 * the World App connect base URL (world.org / staging.world.org /
 * sandbox.world.org), so it decides whether the phone can complete the
 * hand-off at all. It must match the environment the app is provisioned in.
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
  proofVersion,
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
  proofVersion: "3.0" | "4.0";
  open: boolean;
  onOpenChange: (open: boolean) => void;
  onResult: (result: IDKitResult) => void;
  onFailure: (code: string) => void;
}) {
  const shared = {
    open,
    onOpenChange,
    app_id: appId,
    action,
    rp_context: rpContext,
    environment,
    onSuccess: onResult,
    onError: (code: unknown) => onFailure(String(code)),
  } as const;

  if (proofVersion === "3.0") {
    return (
      <IDKitRequestWidget
        {...shared}
        allow_legacy_proofs
        preset={selfieCheckLegacy({ signal })}
      />
    );
  }

  return (
    <IDKitRequestWidget
      {...shared}
      allow_legacy_proofs={false}
      constraints={CredentialRequest(SELFIE_IDENTIFIER, { signal })}
    />
  );
}

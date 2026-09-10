"use client";

import { IDKitRequestWidget, selfieCheckLegacy } from "@worldcoin/idkit";
import type { IDKitResult, RpContext } from "@worldcoin/idkit";

/**
 * The real Selfie Check request, used when live credentials are configured.
 *
 * Two things worth flagging:
 *
 * 1. `allow_legacy_proofs` is REQUIRED by `IDKitRequestConfig` and must be
 *    `true` here. Selfie Check only emits World ID 3.0 proofs, so with `false`
 *    the request has nothing valid to return. (The credentials doc says no
 *    `allow_legacy_proofs` parameter is needed for Selfie Check, which
 *    contradicts the published type.)
 *
 * 2. `rp_context` must be minted server-side per request and is short-lived
 *    (300s default TTL). Reusing one across attempts surfaces as
 *    `rp_signature_expired` or `duplicate_nonce`.
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
      allow_legacy_proofs
      environment="sandbox"
      preset={selfieCheckLegacy({ signal })}
      onSuccess={onResult}
      onError={(code) => onFailure(String(code))}
    />
  );
}

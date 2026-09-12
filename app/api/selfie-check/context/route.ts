import { NextResponse } from "next/server";
import { signRequest } from "@worldcoin/idkit/signing";

import {
  ConfigError,
  environmentAsymmetry,
  requireConfig,
} from "@/lib/selfie-check/config";
import { accountCookie, resolveAccountId } from "@/lib/selfie-check/session";
import type { RpContext } from "@/lib/selfie-check/types";

/** rp_context lifetime, in seconds. Matches signRequest's own default. */
const RP_CONTEXT_TTL_SECONDS = 300;

/**
 * Mint an rp_context for a proof request.
 *
 * The signature is produced server-side — the signing key never reaches the
 * browser. `signRequest` handles the parts that are easy to get wrong by hand:
 * the 32-byte nonce run through `hash_to_field`, the
 * `version || nonce || created_at || expires_at || action` message layout, the
 * EIP-191 prefix, and Keccak-256 (NOT SHA3-256 — different padding, and the
 * failure surfaces only as `invalid_rp_signature`).
 *
 * Note what the signature does NOT cover: the credential requested, the
 * constraint tree, and `allow_legacy_proofs` are all unsigned and chosen by the
 * client. A context minted here can therefore be used to return a proof from a
 * different credential or protocol version, so the verify route re-asserts both
 * rather than trusting that this context was used as intended.
 */
export async function POST() {
  let config;
  try {
    config = requireConfig();
  } catch (error) {
    if (error instanceof ConfigError) {
      return NextResponse.json(
        { ok: false, error: "not_configured", problems: error.problems },
        { status: 503 },
      );
    }
    throw error;
  }

  const { id, isNew } = await resolveAccountId();

  const signed = signRequest({
    signingKeyHex: config.signingKey,
    action: config.action,
    ttl: RP_CONTEXT_TTL_SECONDS,
  });

  const context: RpContext = {
    rp_id: config.rpId,
    nonce: signed.nonce,
    created_at: signed.createdAt,
    expires_at: signed.expiresAt,
    signature: signed.sig,
  };

  const res = NextResponse.json({
    ok: true,
    action: config.action,
    app_id: config.appId,
    environment: config.environment,
    proof_version: config.proofVersion,
    environment_note: environmentAsymmetry(config),
    rp_context: context,
    ttl_seconds: RP_CONTEXT_TTL_SECONDS,
    // The signal binds the proof to this account, so a proof minted for one
    // account cannot be replayed against another. World App hashes it with
    // `hash_to_field`; the verify route re-derives it with `hashSignal`.
    signal: id,
  });
  if (isNew) res.cookies.set(accountCookie(id));
  return res;
}

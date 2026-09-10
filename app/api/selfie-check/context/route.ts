import { randomBytes } from "node:crypto";
import { NextResponse } from "next/server";

import { getConfig } from "@/lib/selfie-check/config";
import { accountCookie, resolveAccountId } from "@/lib/selfie-check/session";
import type { RpContext } from "@/lib/selfie-check/types";

/**
 * Mint an rp_context for a proof request.
 *
 * The signature must be produced server-side — the signing key never reaches
 * the browser. In live mode this delegates to `signRequest` from
 * `@worldcoin/idkit/signing`, which handles the parts that are easy to get
 * wrong by hand: the 32-byte nonce run through `hash_to_field`, the
 * `version || nonce || created_at || expires_at || action` message layout, the
 * EIP-191 prefix, and Keccak-256 (NOT SHA3-256 — different padding, and the
 * failure surfaces only as `invalid_rp_signature`).
 */
export async function POST() {
  const config = getConfig();
  const { id, isNew } = await resolveAccountId();

  let context: RpContext;
  let note: string;

  if (config.mode === "live") {
    const { signRequest } = await import("@worldcoin/idkit/signing");
    const signed = signRequest({
      signingKeyHex: config.signingKey,
      action: config.action,
      ttl: 300,
    });
    context = {
      rp_id: config.rpId,
      nonce: signed.nonce,
      created_at: signed.createdAt,
      expires_at: signed.expiresAt,
      signature: signed.sig,
    };
    note = "Signed with WORLD_RP_SIGNING_KEY via @worldcoin/idkit/signing.";
  } else {
    const createdAt = Math.floor(Date.now() / 1000);
    context = {
      rp_id: process.env.WORLD_RP_ID || "rp_mock000000000",
      nonce: `0x${randomBytes(32).toString("hex")}`,
      created_at: createdAt,
      expires_at: createdAt + 300,
      signature: `0x${randomBytes(65).toString("hex")}`,
    };
    note =
      "Mock context — unsigned. World App would reject this with invalid_rp_signature.";
  }

  const res = NextResponse.json({
    mode: config.mode,
    action: config.action,
    app_id: config.mode === "live" ? config.appId : null,
    rp_context: context,
    // The signal binds the proof to this account, so a proof minted for one
    // account cannot be replayed against another. World App hashes it with
    // `hash_to_field`; the server re-derives it with `hashSignal` to compare.
    signal: id,
    note,
  });
  if (isNew) res.cookies.set(accountCookie(id));
  return res;
}

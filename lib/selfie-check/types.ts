/**
 * Types mirroring the real World ID / IDKit v4 surface for Selfie Check.
 *
 * Selfie Check (credential id 11, identifier "selfie") only emits World ID 3.0
 * proofs, so `selfieCheckLegacy()` returns an `IDKitResultV3`. These local types
 * are structurally identical to `@worldcoin/idkit-core`'s so the mock engine and
 * the live widget can feed the exact same verification path.
 */

/** Credential identifier World App returns for Selfie Check. */
export const SELFIE_IDENTIFIER = "selfie";

/**
 * `face` is a backward-compatible alias for the same credential, so a handler
 * that matches only "selfie" can drop a genuine proof.
 */
export const SELFIE_IDENTIFIERS = ["selfie", "face"] as const;

export function isSelfieIdentifier(identifier: string): boolean {
  return (SELFIE_IDENTIFIERS as readonly string[]).includes(identifier);
}

/**
 * `issuer_schema_id` for Selfie Check, a World ID 4.0-only field.
 *
 * Note that credential id 11 never appears on the wire for Selfie Check: it is
 * a docs URL identifier, and because Selfie Check only emits 3.0 proofs (which
 * carry no `issuer_schema_id`), there is no field in a Selfie Check proof where
 * 11 would show up. Match on the identifier string, not on 11.
 */
export const SELFIE_SCHEMA_ID = 11;

/** `verification_level` the legacy verify endpoint expects for Selfie Check. */
export const SELFIE_VERIFICATION_LEVEL = "selfie";

/** Selfie Check credentials are valid for 90 days from issuance. */
export const SELFIE_VALIDITY_DAYS = 90;

/** Bounds the verify endpoint enforces on `max_age` (seconds). */
export const MAX_AGE_MIN_SECONDS = 3600;
export const MAX_AGE_MAX_SECONDS = 604800;

/** One credential response inside a World ID 3.0 result. */
export type ResponseItemV3 = {
  identifier: string;
  signal_hash?: string;
  proof: string;
  merkle_root: string;
  nullifier: string;
};

/** World ID 3.0 result — what `selfieCheckLegacy()` resolves to. */
export type IDKitResultV3 = {
  protocol_version: "3.0";
  nonce: string;
  action?: string;
  action_description?: string;
  responses: ResponseItemV3[];
  user_presence_completed?: boolean;
  environment: string;
};

/** RP context minted server-side and handed to IDKit. */
export type RpContext = {
  rp_id: string;
  nonce: string;
  created_at: number;
  expires_at: number;
  signature: string;
};

/**
 * Error codes World App can return, copied from
 * `IDKitErrorCode` in @worldcoin/idkit-core.
 */
export const IDKIT_ERROR_CODES = [
  "user_rejected",
  "verification_rejected",
  "credential_unavailable",
  "feature_unavailable",
  "world_id_4_not_available",
  "world_id_3_not_available",
  "malformed_request",
  "invalid_network",
  "inclusion_proof_pending",
  "inclusion_proof_failed",
  "unexpected_response",
  "connection_failed",
  "max_verifications_reached",
  "failed_by_host_app",
  "user_presence_failed",
  "invalid_rp_signature",
  "nullifier_replayed",
  "duplicate_nonce",
  "unknown_rp",
  "inactive_rp",
  "timestamp_too_old",
  "timestamp_too_far_in_future",
  "invalid_timestamp",
  "rp_signature_expired",
  "identity_attributes_not_matched",
  "generic_error",
] as const;

export type IDKitErrorCode = (typeof IDKIT_ERROR_CODES)[number];

/** Error codes the legacy `/api/v2/verify/{app_id}` endpoint returns. */
export const VERIFY_ERROR_CODES = [
  "invalid_proof",
  "invalid_merkle_root",
  "root_too_old",
  "invalid",
  "exceeded_max_verifications",
  "already_verified",
] as const;

export type VerifyErrorCode = (typeof VERIFY_ERROR_CODES)[number];

/** Successful response from `POST /api/v2/verify/{app_id}`. */
export type VerifySuccess = {
  success: true;
  action: string;
  nullifier_hash: string;
  created_at: string;
};

export type VerifyFailure = {
  success: false;
  code: VerifyErrorCode | string;
  detail?: string;
  attribute?: string | null;
};

export type VerifyResponse = VerifySuccess | VerifyFailure;

/**
 * Types mirroring the real World ID / IDKit v4 surface for Selfie Check.
 *
 * Selfie Check is available on BOTH protocol versions, which is easy to get
 * wrong: `selfieCheckLegacy()` is a preset whose JSDoc says it "only returns
 * World ID 3.0 proofs" — a property of the preset, not of the credential.
 * The credential itself appears in the 4.0 union
 * (`CredentialType = "proof_of_human" | "selfie" | "passport" | "mnc"`), so
 * `CredentialRequest("selfie")` yields a 4.0 proof.
 *
 * This app is World ID **3.0** only, because that is the only version Selfie
 * Check is actually issuable on. Measured on one device on 2026-09-13:
 * `selfieCheckLegacy()` verified HTTP 200, while `CredentialRequest("selfie")`
 * — the 4.0 route — returned `credential_unavailable`, i.e. World App holds no
 * 4.0 selfie credential to present. The 4.0 shapes are still modelled below and
 * documented, because the endpoint DOES accept them and the gap is a client-side
 * issuance gap, not a protocol one.
 *
 * Accepting exactly one version is a correctness requirement either way: a
 * human's 3.0 and 4.0 nullifiers are different, unlinkable values, so accepting
 * both would let one person hold two anchors.
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
 * `issuer_schema_id` for Selfie Check — a World ID 4.0-only field.
 *
 * Credential id 11 is what the docs URL is keyed on (/world-id/credentials/11),
 * and it DOES appear on the wire — but only in a 4.0 proof, as
 * `ResponseItemV4.issuer_schema_id`. A legacy 3.0 proof has no numeric field at
 * all, so a handler matching on 11 against a 3.0 response silently matches
 * nothing. Match on the identifier string when handling 3.0.
 */
export const SELFIE_SCHEMA_ID = 11;

/** Selfie Check credentials are valid for 90 days from issuance. */
export const SELFIE_VALIDITY_DAYS = 90;

/** Bounds the verify endpoint enforces on `max_age` (seconds). */
export const MAX_AGE_MIN_SECONDS = 3600;
export const MAX_AGE_MAX_SECONDS = 604800;

/**
 * `verification_level` the legacy v2 verify endpoint expects for Selfie Check.
 * Unused on the v4 path, which identifies the credential by `identifier`.
 */
export const SELFIE_VERIFICATION_LEVEL = "selfie";

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

/** Issuer schema ids that appear in a 4.0 proof (from the SDK's own JSDoc). */
export const SCHEMA_IDS = {
  proof_of_human: 1,
  selfie: 11,
  passport: 9303,
  mnc: 9310,
} as const;

/**
 * One credential response inside a World ID 4.0 result.
 *
 * Differs from the 3.0 shape in three ways that matter to a verifier:
 *   - `proof` is a string ARRAY, not a string (first 4 elements are the
 *     compressed Groth16 proof, the 5th is the merkle root)
 *   - there is no separate `merkle_root` field — it lives at `proof[4]`
 *   - `issuer_schema_id` is present (11 for Selfie Check)
 */
export type ResponseItemV4 = {
  identifier: string;
  signal_hash?: string;
  proof: string[];
  nullifier: string;
  issuer_schema_id: number;
  /**
   * Minimum expiration timestamp (unix seconds). REQUIRED, both in the SDK type
   * and by the endpoint: omitting it from a v4 verify request is rejected with
   * `validation_error` / "expires_at_min is required for v4".
   */
  expires_at_min: number;
  /**
   * REQUIRED by the v4 verify endpoint for a Selfie Check 4.0 response —
   * omitting it is rejected with `validation_error` /
   * "sybil_score is required for Self Check 4.0 responses" — yet it appears
   * NOWHERE in @worldcoin/idkit 4.2.3: not in `ResponseItemV4`, not in the
   * compiled JS, not in the WASM strings.
   *
   * It also contradicts the credential page, which states Selfie Check
   * "returns a proof of the completed check, not a numeric Sybil or uniqueness
   * score".
   *
   * Declared optional here because the SDK cannot guarantee it and this type
   * describes what may arrive, not what the endpoint demands. Whether World App
   * actually emits it can only be settled by a real 4.0 proof. This is exactly
   * why the verify body forwards the response item through rather than
   * rebuilding it from known fields.
   */
  sybil_score?: number;
  /** Anything else World App sends that these types do not model yet. */
  [key: string]: unknown;
};

/** Device signature format used by the integrity bundle. */
export type IntegritySignatureFormat = "apple_app_attest" | "android_keystore";

/**
 * World App integrity bundle, proving request-time app integrity.
 *
 * Produced by the device (Apple App Attest / Android Keystore) with a JWT from
 * World's Attestation Gateway, so a server cannot synthesize one.
 *
 * The SDK marks this OPTIONAL on the result ("Optional World App integrity
 * bundle for this proof request"), but the v4 verify endpoint requires it for a
 * Selfie Check 4.0 response, and requires a specific version:
 *   `integrity_verification_failed` /
 *   "Self Check 4.0 responses require an integrity bundle signed with version 2."
 * Nothing documents which version World App emits, so whether a given build can
 * satisfy this is only discoverable by running a real proof.
 */
export type IntegrityBundle = {
  version: number;
  signature_format: IntegritySignatureFormat;
  timestamp: number;
  signature: string;
  jwt: string;
};

/** World ID 4.0 result — what `CredentialRequest("selfie")` resolves to. */
export type IDKitResultV4 = {
  protocol_version: "4.0";
  nonce: string;
  action?: string;
  action_description?: string;
  responses: ResponseItemV4[];
  user_presence_completed?: boolean;
  environment: string;
  /** Must be forwarded to the verify endpoint — see IntegrityBundle. */
  integrity_bundle?: IntegrityBundle;
};

/**
 * A credential response flattened for policy, storage and display.
 *
 * `merkleRoot` is not a distinct field on 4.0 — it is `proof[4]` — so it is
 * extracted here and is null if the proof array is shorter than expected.
 */
export type NormalizedCredential = {
  protocolVersion: "3.0" | "4.0";
  identifier: string;
  nullifier: string;
  signalHash: string | null;
  merkleRoot: string | null;
  issuerSchemaId: number | null;
  expiresAtMin: number | null;
  /** Display/preview form. The full proof never reaches the client. */
  proofPreview: string;
  /** Character count of the encoded proof, for the inspector. */
  proofLength: number;
};

export function normalizeV3(item: ResponseItemV3): NormalizedCredential {
  return {
    protocolVersion: "3.0",
    identifier: item.identifier,
    nullifier: item.nullifier,
    signalHash: item.signal_hash ?? null,
    merkleRoot: item.merkle_root,
    // 3.0 carries no numeric credential field at all, which is why the
    // identifier string is the ONLY thing identifying the credential here.
    issuerSchemaId: null,
    expiresAtMin: null,
    proofPreview: `${item.proof.slice(0, 34)}…`,
    proofLength: Math.max(0, item.proof.length - 2),
  };
}

export function normalizeV4(item: ResponseItemV4): NormalizedCredential {
  const joined = item.proof.join("");
  return {
    protocolVersion: "4.0",
    identifier: item.identifier,
    nullifier: item.nullifier,
    signalHash: item.signal_hash ?? null,
    // 5th element is the merkle root; tolerate a shorter array rather than
    // throwing, since the array length is not enforced by the type.
    merkleRoot: item.proof[4] ?? null,
    issuerSchemaId: item.issuer_schema_id,
    expiresAtMin: item.expires_at_min,
    proofPreview: `${item.proof[0]?.slice(0, 34) ?? ""}… (${item.proof.length} elements)`,
    proofLength: joined.length,
  };
}

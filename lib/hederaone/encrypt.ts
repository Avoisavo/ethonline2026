// lib/encrypt.ts — AES-256-GCM at-rest encryption for agent private keys (ported from SPARK/DIVE).
import crypto from "crypto";

const ALGORITHM = "aes-256-gcm";
const IV_LENGTH = 16;
const TAG_LENGTH = 16;

/** 32-byte AES key = SHA-256 of ENCRYPTION_KEY (falls back to the operator key so it works out of the box). */
function deriveKey(): Buffer {
  const secret = process.env.ENCRYPTION_KEY || process.env.HEDERA_OPERATOR_KEY;
  if (!secret) throw new Error("Set ENCRYPTION_KEY (or HEDERA_OPERATOR_KEY) to encrypt agent keys");
  return crypto.createHash("sha256").update(secret).digest();
}

/** Encrypt → base64 of: IV(16) + authTag(16) + ciphertext. */
export function encrypt(plaintext: string): string {
  const key = deriveKey();
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, "utf-8"), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString("base64");
}

/** Decrypt a base64 IV+tag+ciphertext payload produced by encrypt(). */
export function decrypt(encryptedBase64: string): string {
  const key = deriveKey();
  const packed = Buffer.from(encryptedBase64, "base64");
  const iv = packed.subarray(0, IV_LENGTH);
  const tag = packed.subarray(IV_LENGTH, IV_LENGTH + TAG_LENGTH);
  const ciphertext = packed.subarray(IV_LENGTH + TAG_LENGTH);
  const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(ciphertext), decipher.final()]).toString("utf-8");
}

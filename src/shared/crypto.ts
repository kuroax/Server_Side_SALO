import crypto from "node:crypto";
import { BOUTIQUE_TOKEN_ENCRYPTION_KEY } from "#/config/env.js";

// ─── AES-256-GCM at-rest encryption for boutique.accessToken ───────────────────
//
// Stored format: "<iv_hex>:<authTag_hex>:<ciphertext_hex>"
//   - iv:        12 random bytes, regenerated per encrypt() call
//   - authTag:   16-byte GCM authentication tag (detects tampering / wrong key)
//   - ciphertext: the encrypted token bytes
//
// The key comes from BOUTIQUE_TOKEN_ENCRYPTION_KEY (64 hex chars = 32 bytes),
// validated in env.ts at startup. No external dependencies — Node built-in only.

const ALGORITHM = "aes-256-gcm";
const IV_BYTES = 12; // GCM standard nonce length
const KEY_BYTES = 32; // AES-256

// Matches the "<hex>:<hex>:<hex>" stored format. Used by isEncrypted() and as a
// shape guard in decrypt(). Case-insensitive; each segment must be non-empty hex.
const ENCRYPTED_FORMAT = /^[0-9a-f]+:[0-9a-f]+:[0-9a-f]+$/i;

const HEX_ONLY = /^[0-9a-f]+$/i;

// Resolves and validates the 32-byte key from the env var. Throws a descriptive
// error if the configured value is not valid hex or does not decode to 32 bytes.
function getKey(): Buffer {
  const raw = BOUTIQUE_TOKEN_ENCRYPTION_KEY.trim();

  if (!HEX_ONLY.test(raw) || raw.length % 2 !== 0) {
    throw new Error(
      "BOUTIQUE_TOKEN_ENCRYPTION_KEY is not valid hex — expected 64 hex characters",
    );
  }

  const key = Buffer.from(raw, "hex");
  if (key.length !== KEY_BYTES) {
    throw new Error(
      `BOUTIQUE_TOKEN_ENCRYPTION_KEY must decode to ${KEY_BYTES} bytes (got ${key.length}) — expected 64 hex characters`,
    );
  }

  return key;
}

// Encrypts a plaintext string with a fresh random IV.
// Returns "<iv_hex>:<authTag_hex>:<ciphertext_hex>".
export function encrypt(plaintext: string): string {
  const key = getKey();
  const iv = crypto.randomBytes(IV_BYTES);

  const cipher = crypto.createCipheriv(ALGORITHM, key, iv);
  const ciphertext = Buffer.concat([
    cipher.update(plaintext, "utf8"),
    cipher.final(),
  ]);
  const authTag = cipher.getAuthTag();

  return `${iv.toString("hex")}:${authTag.toString("hex")}:${ciphertext.toString("hex")}`;
}

// Parses the "<iv_hex>:<authTag_hex>:<ciphertext_hex>" format and returns the
// original plaintext. Throws a descriptive error on any failure — wrong key,
// tampered data (GCM auth tag mismatch), or malformed input.
export function decrypt(payload: string): string {
  if (typeof payload !== "string" || !ENCRYPTED_FORMAT.test(payload)) {
    throw new Error(
      "Failed to decrypt: value is not in <iv>:<authTag>:<ciphertext> hex format",
    );
  }

  const [ivHex, tagHex, dataHex] = payload.split(":");
  const key = getKey();

  try {
    const iv = Buffer.from(ivHex, "hex");
    const authTag = Buffer.from(tagHex, "hex");
    const data = Buffer.from(dataHex, "hex");

    const decipher = crypto.createDecipheriv(ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    return Buffer.concat([decipher.update(data), decipher.final()]).toString(
      "utf8",
    );
  } catch {
    // Wrong key or tampered ciphertext — GCM final() throws on auth failure.
    throw new Error(
      "Failed to decrypt boutique access token — wrong key or corrupted/tampered data",
    );
  }
}

// True if the value matches the "<hex>:<hex>:<hex>" encrypted format.
// Used to detect plaintext tokens during migration and to make the model
// hooks idempotent (never double-encrypt, never decrypt plaintext).
export function isEncrypted(value: string): boolean {
  return typeof value === "string" && ENCRYPTED_FORMAT.test(value);
}

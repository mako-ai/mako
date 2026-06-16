import * as crypto from "crypto";

/**
 * AES-256-CBC encryption helpers for the Postgres persistence layer.
 *
 * Deliberately standalone (no Mongoose import) but byte-for-byte compatible
 * with the legacy Mongoose getters/setters in `database/workspace-schema.ts`:
 * same `ENCRYPTION_KEY`, same `aes-256-cbc`, same `iv:ciphertext` hex envelope.
 * This lets the backfill re-encrypt connection credentials with the same key so
 * the Postgres rows are interchangeable with the Mongo originals.
 */

let cachedKey: string | null = null;

function getEncryptionKey(): string {
  if (!cachedKey) {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) {
      throw new Error("ENCRYPTION_KEY environment variable is not set");
    }
    cachedKey = key;
  }
  return cachedKey;
}

const IV_LENGTH = 16;

export function encrypt(text: string): string {
  const iv = crypto.randomBytes(IV_LENGTH);
  const cipher = crypto.createCipheriv(
    "aes-256-cbc",
    Buffer.from(getEncryptionKey(), "hex"),
    iv,
  );
  let encrypted = cipher.update(text);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

export function decrypt(text: string): string {
  const textParts = text.split(":");
  const ivHex = textParts.shift();
  if (!ivHex) {
    throw new Error("Invalid encrypted text format: missing IV");
  }
  const iv = Buffer.from(ivHex, "hex");
  const encryptedText = Buffer.from(textParts.join(":"), "hex");
  const decipher = crypto.createDecipheriv(
    "aes-256-cbc",
    Buffer.from(getEncryptionKey(), "hex"),
    iv,
  );
  let decrypted = decipher.update(encryptedText);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

/** Recursively encrypt every non-empty string leaf of a plain object. */
export function encryptObject<T>(obj: T): T {
  if (typeof obj === "string") {
    return (obj ? encrypt(obj) : obj) as T;
  }
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => encryptObject(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    out[key] = encryptObject((obj as Record<string, unknown>)[key]);
  }
  return out as T;
}

/** Recursively decrypt every `iv:ciphertext` string leaf of a plain object. */
export function decryptObject<T>(obj: T): T {
  if (typeof obj === "string") {
    if (obj.includes(":")) {
      try {
        return decrypt(obj) as unknown as T;
      } catch {
        return obj;
      }
    }
    return obj;
  }
  if (obj === null || typeof obj !== "object") {
    return obj;
  }
  if (Array.isArray(obj)) {
    return obj.map(item => decryptObject(item)) as unknown as T;
  }
  const out: Record<string, unknown> = {};
  for (const key of Object.keys(obj as Record<string, unknown>)) {
    out[key] = decryptObject((obj as Record<string, unknown>)[key]);
  }
  return out as T;
}

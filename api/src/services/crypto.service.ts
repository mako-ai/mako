/**
 * THE AES-256-CBC encryption for credentials at rest — the only one.
 *
 * Wire format `<iv_hex>:<ciphertext_hex>` with the ENCRYPTION_KEY env var
 * (32-byte hex). There used to be four copies of this (workspace-schema,
 * routes/sources, sync/destination-manager, sync/database-data-source-
 * manager) with different guards: one double-encrypted on round-trips, one
 * rejected any plaintext containing ":", one swallowed the error. They all
 * delegate here now; `encryptString`/`decryptString` are tolerant (a value
 * not in encrypted form passes through unchanged — legacy plaintext), and
 * `decryptEncrypted` is strict for values that must never be plaintext.
 */

import crypto from "crypto";

const ENCRYPTED_VALUE_PATTERN = /^[0-9a-fA-F]{32}:[0-9a-fA-F]+$/;

function getEncryptionKey(): Buffer {
  const encryptionKey = process.env.ENCRYPTION_KEY;
  if (!encryptionKey) {
    throw new Error("ENCRYPTION_KEY environment variable is not set");
  }
  return Buffer.from(encryptionKey, "hex");
}

export function isEncryptedValue(value: string): boolean {
  return ENCRYPTED_VALUE_PATTERN.test(value);
}

export function encryptString(value: string): string {
  // Already in encrypted form — don't double-encrypt on round-trips.
  if (isEncryptedValue(value)) return value;

  const key = getEncryptionKey();
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv("aes-256-cbc", key, iv);
  let encrypted = cipher.update(value);
  encrypted = Buffer.concat([encrypted, cipher.final()]);
  return iv.toString("hex") + ":" + encrypted.toString("hex");
}

export function decryptString(value: string): string {
  if (!isEncryptedValue(value)) return value;

  const key = getEncryptionKey();
  const [ivHex, ...rest] = value.split(":");
  const iv = Buffer.from(ivHex, "hex");
  const encrypted = Buffer.from(rest.join(":"), "hex");
  const decipher = crypto.createDecipheriv("aes-256-cbc", key, iv);
  let decrypted = decipher.update(encrypted);
  decrypted = Buffer.concat([decrypted, decipher.final()]);
  return decrypted.toString();
}

/**
 * Decrypt a value that MUST be in encrypted form — for credentials that are
 * always stored encrypted (destination connection strings), where a value
 * that is not `iv:ciphertext` is corruption, not plaintext, and passing it
 * through would hand a downstream driver garbage with a confusing error.
 */
export function decryptEncrypted(value: string): string {
  if (!isEncryptedValue(value)) {
    throw new Error("Invalid encrypted value format (expected iv:ciphertext)");
  }
  return decryptString(value);
}

/** Encrypt every value of a string record (e.g. auth headers). */
export function encryptRecord(
  record: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k, encryptString(v)]),
  );
}

/** Decrypt every value of a string record (e.g. auth headers). */
export function decryptRecord(
  record: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(
    Object.entries(record).map(([k, v]) => [k, decryptString(v)]),
  );
}

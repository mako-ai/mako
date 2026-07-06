/**
 * Shared AES-256-CBC encryption for credentials at rest.
 *
 * Same wire format as the connector-config encryption in routes/sources.ts
 * (`<iv_hex>:<ciphertext_hex>` using the ENCRYPTION_KEY env var) so existing
 * encrypted values remain readable. New credential storage (e.g. MCP
 * connection configs) should use this service instead of re-implementing it.
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

/**
 * Explicit repository-layer AES-256-CBC leaf encryption for `database_connections.connection`.
 *
 * Replaces the implicit Mongoose `set: encryptObject` / `get: decryptObject` hooks so
 * Postgres (`connection_encrypted jsonb`) and MongoDB (`databaseconnections.connection`)
 * share one encryption pipeline:
 *   - `encryptConnectionObject()` recursively encrypts every non-empty string leaf
 *     (including nested `sshTunnel`, preserving arrays!) using `encryptString()`.
 *     Idempotent on already-encrypted `iv:ciphertext` leaves.
 *     Fails CLOSED if `ENCRYPTION_KEY` is missing or invalid.
 *   - `decryptConnectionObject()` handles legacy JSON-stringified `connection` values
 *     with the non-string recursion guard from `database-connections.ts`, and
 *     recursively decrypts `iv:ciphertext` leaves via `decryptString()`.
 */
import { loggers } from "../../logging";
import { decryptString, encryptString } from "../../services/crypto.service";

const logger = loggers.db();

function encryptNode(value: unknown): unknown {
  if (typeof value === "string") {
    if (value.length === 0) return value;
    // Fails CLOSED if ENCRYPTION_KEY is missing/invalid; idempotent on `iv:hex`.
    return encryptString(value);
  }
  if (Array.isArray(value)) {
    return value.map(item => encryptNode(item));
  }
  if (value !== null && typeof value === "object") {
    if (value instanceof Date) return value.toISOString();
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (nested !== undefined) {
        out[key] = encryptNode(nested);
      }
    }
    return out;
  }
  return value;
}

/**
 * Recursively encrypt every non-empty string leaf of a database connection
 * config object. Never mutates input; preserves arrays; fails CLOSED without
 * `ENCRYPTION_KEY`.
 */
export function encryptConnectionObject(
  plain: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!plain || typeof plain !== "object" || Array.isArray(plain)) {
    return {};
  }
  return encryptNode(plain) as Record<string, unknown>;
}

function decryptNode(value: unknown): unknown {
  try {
    // Legacy JSON-stringified connection payloads: only recurse when JSON.parse
    // yields a non-string (object/array) to prevent infinite recursion on
    // doubly-quoted strings like '"foo"'.
    if (typeof value === "string") {
      try {
        const parsed: unknown = JSON.parse(value);
        if (parsed !== null && typeof parsed === "object") {
          return decryptNode(parsed);
        }
      } catch {
        // Not valid JSON — fall through to leaf decrypt
      }
      if (!value.includes(":")) {
        return value;
      }
      try {
        return decryptString(value);
      } catch {
        return value;
      }
    }
    if (Array.isArray(value)) {
      return value.map(item => decryptNode(item));
    }
    if (value === null || typeof value !== "object") {
      return value;
    }
    const out: Record<string, unknown> = {};
    for (const [key, nested] of Object.entries(
      value as Record<string, unknown>,
    )) {
      if (typeof nested === "string" && nested.includes(":")) {
        try {
          out[key] = decryptString(nested);
        } catch {
          out[key] = nested;
        }
      } else if (nested !== null && typeof nested === "object") {
        try {
          out[key] = decryptNode(nested);
        } catch {
          out[key] = nested;
        }
      } else {
        out[key] = nested;
      }
    }
    return out;
  } catch (error) {
    logger.warn("decryptConnectionObject failed — returning raw value", {
      error,
    });
    return value;
  }
}

/**
 * Recursively decrypt a stored `database_connections.connection_encrypted`
 * (or raw Mongo `connection`) payload. Never mutates input; preserves arrays.
 */
export function decryptConnectionObject(
  stored: unknown,
): Record<string, unknown> {
  const decrypted = decryptNode(stored);
  if (
    decrypted !== null &&
    typeof decrypted === "object" &&
    !Array.isArray(decrypted)
  ) {
    return decrypted as Record<string, unknown>;
  }
  return {};
}

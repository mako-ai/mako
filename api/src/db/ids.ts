/**
 * Deterministic, reversible conversion between Mongo identifiers and Postgres
 * `uuid` values.
 *
 * Two id shapes exist in the legacy Mongo data:
 *
 *  1. **ObjectId** (12 bytes / 24 hex chars) — used by every workspace-scoped
 *     collection (`Workspace`, `Chat`, `DatabaseConnection`, …).
 *  2. **UUID-v4 string** — already used by `User`, `Session` (well, session ids
 *     are 64-hex), `EmailVerification`, etc.
 *
 * A Postgres `uuid` is 16 bytes / 32 hex chars and does NOT validate the
 * RFC-4122 version/variant nibbles, so we can losslessly embed a 12-byte
 * ObjectId in the first 12 bytes and pad the trailing 4 bytes with zeros:
 *
 *   507f1f77bcf86cd799439011  ->  507f1f77-bcf8-6cd7-9943-901100000000
 *
 * This mapping is:
 *   - deterministic   (same ObjectId always yields the same uuid)
 *   - reversible      (strip the trailing zero bytes to recover the ObjectId)
 *   - order-preserving (ObjectId's leading timestamp bytes sort the same way)
 *
 * Because it is reversible, a gradual migration needs no id-mapping table:
 * any code holding an ObjectId can compute its Postgres key locally and back.
 */

import { v5 as uuidv5 } from "uuid";

const OBJECT_ID_RE = /^[0-9a-f]{24}$/i;
const UUID_RE =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** The 8-hex (4-byte) zero pad appended to an ObjectId to fill 16 bytes. */
const OBJECT_ID_PAD = "00000000";

/**
 * Fixed namespace for hashing legacy non-standard identifiers (nanoids,
 * sentinels like `"system"`/`"agent"`) into stable uuids. Real Mongo data is
 * heterogeneous: not every `_id`/reference is an ObjectId or uuid. UUIDv5 is
 * deterministic, so a legacy id and every reference to it hash to the SAME
 * uuid — foreign keys still line up without a mapping table (the trade-off vs.
 * the ObjectId padding is that v5 hashing is one-way, which is fine for these).
 */
const LEGACY_ID_NAMESPACE = "6f1a7b54-8b1e-4c2a-9d3f-0a1b2c3d4e5f";

function formatHexAsUuid(hex32: string): string {
  return [
    hex32.slice(0, 8),
    hex32.slice(8, 12),
    hex32.slice(12, 16),
    hex32.slice(16, 20),
    hex32.slice(20, 32),
  ].join("-");
}

/** Returns true if `value` looks like a 24-char hex Mongo ObjectId. */
export function isObjectIdHex(value: string): boolean {
  return OBJECT_ID_RE.test(value);
}

/** Returns true if `value` is a canonical 8-4-4-4-12 uuid string. */
export function isUuid(value: string): boolean {
  return UUID_RE.test(value);
}

/**
 * Convert a 24-hex Mongo ObjectId to its deterministic Postgres uuid.
 * Throws if `objectId` is not a 24-char hex string.
 */
export function objectIdToUuid(objectId: string): string {
  const hex = String(objectId).toLowerCase();
  if (!OBJECT_ID_RE.test(hex)) {
    throw new Error(`Not a valid ObjectId hex string: ${objectId}`);
  }
  return formatHexAsUuid(hex + OBJECT_ID_PAD);
}

/**
 * Recover the original ObjectId hex from a uuid produced by
 * {@link objectIdToUuid}. Throws if the uuid was not produced from an ObjectId
 * (i.e. its trailing 4 bytes are not zero).
 */
export function uuidToObjectId(uuid: string): string {
  const hex = String(uuid).toLowerCase().replace(/-/g, "");
  if (hex.length !== 32 || !/^[0-9a-f]{32}$/.test(hex)) {
    throw new Error(`Not a valid uuid: ${uuid}`);
  }
  if (hex.slice(24) !== OBJECT_ID_PAD) {
    throw new Error(`uuid was not derived from an ObjectId: ${uuid}`);
  }
  return hex.slice(0, 24);
}

/** True if a uuid encodes a padded ObjectId (round-trips via uuidToObjectId). */
export function isObjectIdDerivedUuid(uuid: string): boolean {
  const hex = String(uuid).toLowerCase().replace(/-/g, "");
  return (
    hex.length === 32 &&
    /^[0-9a-f]{32}$/.test(hex) &&
    hex.slice(24) === OBJECT_ID_PAD
  );
}

/**
 * Normalize any legacy Mongo `_id`/reference to a Postgres uuid string. Total:
 * every input yields a valid uuid.
 *
 *   - ObjectId hex (24 chars)            -> reversible padded uuid
 *   - existing uuid (e.g. `User._id`)    -> unchanged (lowercased)
 *   - anything else (nanoid, "system",   -> deterministic UUIDv5 hash
 *     "agent", legacy short ids)
 *
 * Note: 64-hex session ids are stored in a `text` column and must NOT be passed
 * here — use them verbatim.
 */
export function toPgId(value: string): string {
  const v = String(value);
  if (OBJECT_ID_RE.test(v)) {
    return objectIdToUuid(v);
  }
  if (UUID_RE.test(v)) {
    return v.toLowerCase();
  }
  return uuidv5(v, LEGACY_ID_NAMESPACE);
}

/** Null-safe {@link toPgId}. */
export function toPgIdOrNull(value: string | null | undefined): string | null {
  if (value === null || value === undefined || value === "") {
    return null;
  }
  return toPgId(value);
}

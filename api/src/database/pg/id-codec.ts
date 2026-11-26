/**
 * Bijective MongoDB ObjectId <-> Postgres UUID codec (RFC 9562 UUIDv8).
 *
 * Maps EVERY 96-bit MongoDB ObjectId (all 2^96 values, including SHA-1-derived
 * 24-hex IDs from `derivedAppId()` / `derivedConsoleId()` whose upper 32 bits
 * are arbitrary hash bytes rather than current Unix timestamps) losslessly into
 * a disjoint RFC 9562 UUIDv8 subspace I, and back.
 *
 * Bit layout (128 bits = 32 hex chars, MSB-first):
 *   bits   0..47  (48 bits, hex  0..11): ts_ms = uint48(uint32(T) * 1000)
 *                                         max = 0xFFFFFFFF * 1000 = 0x03E7FFFFFC18 (< 2^42)
 *   bits  48..51  ( 4 bits, hex     12): version     = 0x8 (RFC 9562 UUIDv8)
 *   bits  52..59  ( 8 bits, hex 13..14): sentinel_hi = 0x6d (ASCII 'm' for Mongo/Mako)
 *   bits  60..63  ( 4 bits, hex     15): P0 (high nibble of ObjectId byte 4)
 *   bits  64..65  ( 2 bits, hex 16 hi ): variant     = 0b10 (RFC 9562)
 *   bits  66..67  ( 2 bits, hex 16 lo ): sentinel_lo = 0b10 -> hex char 16 is always 'a'
 *   bits  68..127 (60 bits, hex 17..31): P1..P15 (remaining 15 hex chars of bytes 4..11)
 *
 * Canonical string:
 *   HHHHHHHH-HHHH-86dP0-aP1P2P3-P4P5P6P7P8P9P10P11P12P13P14P15
 *
 * Properties:
 *   1. Strict bijection over all 2^96 ObjectIds (no bit-shifts on P).
 *   2. Zero false positives against native Postgres UUIDv7 (ver 7) or UUIDv4 (ver 4).
 *   3. Strictly order-preserving: oid1 < oid2  <=>  objectIdToUuid(oid1) < objectIdToUuid(oid2).
 *   4. Interleaves on the exact Unix millisecond timeline with future native UUIDv7 rows
 *      for B-tree append locality.
 *   5. Valid RFC 9562 UUID accepted by Postgres `uuid`, Zod v4 `z.uuid()`, and drivers.
 */
import { randomBytes } from "node:crypto";

const OBJECT_ID_HEX_RE = /^[0-9a-fA-F]{24}$/;
const CANONICAL_UUID_RE =
  /^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$/;

/** Maximum valid 48-bit timestamp in ms produced by `uint32(0xffffffff) * 1000`. */
export const MAX_OBJECTID_TS_MS = 0xffffffffn * 1000n; // 4_294_967_295_000n (0x03e7fffffc18n)

/** Fixed 12-bit prefix in group 3: version `8` + magic `0x6d` ('m'). */
export const OBJECTID_UUID_VERSION_MAGIC = "86d";

/** Fixed nibble in group 4: RFC 9562 variant `10` + sub-sentinel `10` = `0xa`. */
export const OBJECTID_UUID_VARIANT_MAGIC = "a";

export interface ParsedEntityId {
  /** Lowercase 24-hex ObjectId if the input was an ObjectId or in the ObjectId UUIDv8 subspace; null for native UUIDv4/v7. */
  oid: string | null;
  /** Lowercase canonical 36-char UUID string for Postgres queries. */
  uuid: string;
}

export interface DualId {
  /** Lowercase 24-hex MongoDB ObjectId string. */
  oid: string;
  /** Deterministic RFC 9562 UUIDv8 in the ObjectId subspace. */
  uuid: string;
}

/**
 * Strict 24-hex ObjectId validator.
 * Unlike Mongoose's `Types.ObjectId.isValid()`, rejects arbitrary 12-char ASCII strings.
 */
export function isObjectIdHex(value: unknown): value is string {
  return typeof value === "string" && OBJECT_ID_HEX_RE.test(value);
}

/** Strict 36-char hyphenated UUID format validator (case-insensitive). */
export function isUuidString(value: unknown): value is string {
  return typeof value === "string" && CANONICAL_UUID_RE.test(value);
}

/**
 * Normalize an entity ID for migration control-plane storage/lookups:
 * lowercases case-insensitive hex formats (UUIDs and 24-hex ObjectIds) while
 * preserving exact case for case-sensitive text PKs (e.g., base64url SHA-256
 * `desktop_auth_codes.id` or Lucia user IDs).
 */
export function normalizeEntityId(id: string): string {
  if (CANONICAL_UUID_RE.test(id) || OBJECT_ID_HEX_RE.test(id)) {
    return id.toLowerCase();
  }
  return id;
}

/**
 * Deterministically convert a 24-hex MongoDB ObjectId to its RFC 9562 UUIDv8.
 * Case-insensitive on input; always outputs canonical lowercase UUID.
 */
export function objectIdToUuid(oid: string): string {
  if (!OBJECT_ID_HEX_RE.test(oid)) {
    throw new Error(`Invalid MongoDB ObjectId: ${JSON.stringify(oid)}`);
  }
  const hex = oid.toLowerCase();
  const tsSec = BigInt("0x" + hex.slice(0, 8));
  const tsMsHex = (tsSec * 1000n).toString(16).padStart(12, "0");
  const payload = hex.slice(8); // 16 hex chars (64 bits)

  return (
    `${tsMsHex.slice(0, 8)}-` +
    `${tsMsHex.slice(8, 12)}-` +
    `${OBJECTID_UUID_VERSION_MAGIC}${payload[0]}-` +
    `${OBJECTID_UUID_VARIANT_MAGIC}${payload.slice(1, 4)}-` +
    `${payload.slice(4, 16)}`
  );
}

/**
 * Test whether a UUID belongs to the bijective ObjectId UUIDv8 subspace.
 * Mathematically disjoint from native UUIDv4 and UUIDv7 (0% false positives).
 */
export function isObjectIdUuid(uuid: unknown): boolean {
  if (typeof uuid !== "string" || !CANONICAL_UUID_RE.test(uuid)) {
    return false;
  }
  const u = uuid.toLowerCase();
  if (
    u[14] !== "8" ||
    u[15] !== "6" ||
    u[16] !== "d" ||
    u[19] !== OBJECTID_UUID_VARIANT_MAGIC
  ) {
    return false;
  }
  const tsMs = BigInt("0x" + u.slice(0, 8) + u.slice(9, 13));
  return tsMs <= MAX_OBJECTID_TS_MS && tsMs % 1000n === 0n;
}

/**
 * Losslessly invert a UUID in the ObjectId UUIDv8 subspace back to its exact
 * canonical lowercase 24-hex MongoDB ObjectId.
 */
export function uuidToObjectId(uuid: string): string {
  if (!isObjectIdUuid(uuid)) {
    throw new Error(
      `UUID is not in the ObjectId subspace: ${JSON.stringify(uuid)}`,
    );
  }
  const u = uuid.toLowerCase();
  const tsMs = BigInt("0x" + u.slice(0, 8) + u.slice(9, 13));
  const tsHex = (tsMs / 1000n).toString(16).padStart(8, "0");
  return tsHex + u[17] + u.slice(20, 23) + u.slice(24, 36);
}

/**
 * Extract the embedded Unix timestamp (Date) from an ObjectId-mapped UUIDv8,
 * or null if the UUID is outside the ObjectId subspace.
 *
 * Note: For SHA-1 derived IDs (`derivedAppId`, `derivedConsoleId`), the
 * embedded 32-bit field holds hash bits rather than a creation time.
 */
export function objectIdUuidTimestamp(uuid: string): Date | null {
  if (!isObjectIdUuid(uuid)) {
    return null;
  }
  const u = uuid.toLowerCase();
  const tsMs = BigInt("0x" + u.slice(0, 8) + u.slice(9, 13));
  return new Date(Number(tsMs));
}

/**
 * Serialize a Postgres UUID for external API responses.
 * Returns canonical 24-hex ObjectId for all rows in the ObjectId subspace
 * (preserving 100% API, frontend, CLI, SDK, and Cloudflare app-router compatibility),
 * and lowercase canonical UUID for post-migration native UUIDv7/v4 rows.
 */
export function toWireId(pgUuid: string): string {
  if (!CANONICAL_UUID_RE.test(pgUuid)) {
    throw new Error(`Invalid Postgres UUID: ${JSON.stringify(pgUuid)}`);
  }
  return isObjectIdUuid(pgUuid) ? uuidToObjectId(pgUuid) : pgUuid.toLowerCase();
}

/**
 * Parse an incoming API/route entity ID accepting EITHER a 24-hex ObjectId OR
 * a 36-char canonical UUID (translated UUIDv8 or native UUIDv7/v4).
 * Returns null when the input is neither format.
 */
export function parseEntityId(raw: unknown): ParsedEntityId | null {
  if (typeof raw !== "string") {
    return null;
  }
  if (OBJECT_ID_HEX_RE.test(raw)) {
    const oid = raw.toLowerCase();
    return { oid, uuid: objectIdToUuid(oid) };
  }
  if (CANONICAL_UUID_RE.test(raw)) {
    const uuid = raw.toLowerCase();
    return {
      oid: isObjectIdUuid(uuid) ? uuidToObjectId(uuid) : null,
      uuid,
    };
  }
  return null;
}

/**
 * Optional helper for nullable foreign keys (e.g., `activeWorkspaceId`, `chatId`).
 * Returns null for null/undefined, throws on malformed non-empty strings.
 */
export function optionalObjectIdToUuid(
  oid: string | null | undefined,
): string | null {
  if (oid == null) return null;
  return objectIdToUuid(oid);
}

/**
 * Optional inverse for nullable Postgres UUID foreign keys.
 */
export function optionalToWireId(
  pgUuid: string | null | undefined,
): string | null {
  if (pgUuid == null) return null;
  return toWireId(pgUuid);
}

// Dependency-free BSON ObjectId generator (4B unix_sec + 5B process CSPRNG + 3B atomic counter)
// so Postgres-primary writes during dual-run need no Mongoose/BSON runtime dependency.
const PROCESS_RANDOM_5B = randomBytes(5);
let monotonicCounter = randomBytes(3).readUIntBE(0, 3);

/**
 * Mint a fresh spec-compliant 24-hex MongoDB ObjectId without importing bson/mongoose.
 */
export function generateObjectIdHex(nowMs: number = Date.now()): string {
  const buf = Buffer.allocUnsafe(12);
  const tsSec = Math.floor(nowMs / 1000) >>> 0;
  buf.writeUInt32BE(tsSec, 0);
  PROCESS_RANDOM_5B.copy(buf, 4);
  monotonicCounter = (monotonicCounter + 1) & 0xffffff;
  buf.writeUIntBE(monotonicCounter, 9, 3);
  return buf.toString("hex");
}

/**
 * Mint a dual-compatible ID pair `{ oid, uuid }` inside the bijective ObjectId subspace.
 * Use this for ALL new entity creations while MongoDB dual-write / rollback is active.
 */
export function newDualId(nowMs: number = Date.now()): DualId {
  const oid = generateObjectIdHex(nowMs);
  return { oid, uuid: objectIdToUuid(oid) };
}

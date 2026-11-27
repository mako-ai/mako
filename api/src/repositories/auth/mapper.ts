/**
 * Bidirectional MongoDB <-> Postgres <-> DTO mappers for the `auth` domain (Decision #3).
 */
import { createHash } from "node:crypto";
import type { Types } from "mongoose";
import {
  isObjectIdHex,
  isUuidv7,
  legacyUserIdToUuidv7,
  objectIdToUuid,
  optionalToWireId,
  parseEntityId,
  toWireId,
} from "../../database/pg/id-codec";
import type {
  DesktopAuthCodeRow,
  EmailVerificationRow,
  NewDesktopAuthCodeRow,
  NewEmailVerificationRow,
  NewOAuthAccountRow,
  NewUserAttributionRow,
  NewUserRow,
  OAuthAccountRow,
  OnboardingCompanySize,
  SessionRow,
  UserAttributionRow,
  UserRow,
} from "../../database/pg/schema/auth";
import type {
  DesktopAuthCodeRecord,
  EmailVerificationRecord,
  OAuthAccountRecord,
  SessionRecord,
  UserAttributionRecord,
  UserOnboarding,
  UserRecord,
} from "./types";

const VALID_COMPANY_SIZES = new Set<OnboardingCompanySize>([
  "hobby",
  "startup",
  "growth",
  "enterprise",
]);

export function normalizeEmailKey(email: string | null | undefined): string {
  if (typeof email !== "string") return "";
  return email.trim().toLowerCase();
}

/**
 * Derive the Postgres `sessions.token_hash` primary key from a raw `auth_session`
 * cookie bearer token (SHA-256 hex digest). Raw tokens never enter Postgres.
 */
export function hashSessionToken(rawToken: string): string {
  return createHash("sha256").update(rawToken, "utf8").digest("hex");
}

/**
 * Derive the canonical Postgres UUIDv7 for a MongoDB user `_id`:
 *   - Already a valid RFC 9562 UUIDv7 (new users) -> preserved as lowercase UUIDv7
 *   - Legacy 15-char Lucia ID or legacy UUIDv4 -> deterministic `legacyUserIdToUuidv7(id, createdAt)`
 */
export function deriveUserUuidv7(id: string, createdAt?: Date): string {
  if (isUuidv7(id)) {
    return id.toLowerCase();
  }
  return legacyUserIdToUuidv7(id, createdAt);
}

export function coerceDate(
  value: Date | string | number | null | undefined,
  fallback?: Date,
): Date {
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? (fallback ?? new Date(0)) : value;
  }
  if (typeof value === "string" || typeof value === "number") {
    const parsed = new Date(value);
    if (!Number.isNaN(parsed.getTime())) {
      return parsed;
    }
  }
  return fallback ?? new Date(0);
}

/**
 * Strip `undefined` object entries recursively so Mongoose mixed objects and
 * Postgres `jsonb` columns serialize identically.
 */
export function stripUndefinedDeep(value: unknown): unknown {
  if (value === null || value === undefined) return value;
  if (value instanceof Date) return value;
  if (Array.isArray(value)) {
    return value.map(item => stripUndefinedDeep(item));
  }
  if (typeof value === "object") {
    const out: Record<string, unknown> = {};
    for (const [k, v] of Object.entries(value as Record<string, unknown>)) {
      if (v !== undefined) {
        out[k] = stripUndefinedDeep(v);
      }
    }
    return out;
  }
  return value;
}

export function sanitizeTouchPayload(
  raw: Record<string, unknown> | null | undefined,
): Record<string, unknown> {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) {
    return {};
  }
  return stripUndefinedDeep(raw) as Record<string, unknown>;
}

export function normalizeOnboarding(
  raw:
    | {
        completedAt?: Date | string | null;
        companySize?: string | null;
        role?: string | null;
        primaryDatabase?: string | null;
        dataWarehouse?: string | null;
      }
    | null
    | undefined,
): UserOnboarding | undefined {
  if (!raw || typeof raw !== "object") return undefined;

  const out: UserOnboarding = {};
  if (raw.completedAt != null) {
    const d = coerceDate(raw.completedAt);
    if (!Number.isNaN(d.getTime())) {
      out.completedAt = d;
    }
  }
  if (
    typeof raw.companySize === "string" &&
    VALID_COMPANY_SIZES.has(raw.companySize as OnboardingCompanySize)
  ) {
    out.companySize = raw.companySize as OnboardingCompanySize;
  }
  if (raw.role != null) {
    out.role = raw.role;
  }
  if (raw.primaryDatabase != null) {
    out.primaryDatabase = raw.primaryDatabase;
  }
  if (raw.dataWarehouse != null) {
    out.dataWarehouse = raw.dataWarehouse;
  }

  return Object.keys(out).length > 0 ? out : undefined;
}

export interface MongoUserLike {
  _id: string;
  email?: string | null;
  name?: string | null;
  hashedPassword?: string | null;
  emailVerified?: boolean;
  onboarding?: {
    completedAt?: Date | string | null;
    companySize?: string | null;
    role?: string | null;
    primaryDatabase?: string | null;
    dataWarehouse?: string | null;
  } | null;
  createdAt?: Date | string;
  updatedAt?: Date | string;
}

export function mongoUserToRecord(doc: MongoUserLike): UserRecord {
  const id = String(doc._id);
  const createdAt = coerceDate(doc.createdAt);
  const updatedAt = coerceDate(doc.updatedAt, createdAt);
  const onboarding = normalizeOnboarding(doc.onboarding);
  const record: UserRecord = {
    id,
    _id: id,
    legacyId: id,
    email: normalizeEmailKey(typeof doc.email === "string" ? doc.email : ""),
    emailVerified: Boolean(doc.emailVerified),
    createdAt,
    updatedAt,
  };
  if (typeof doc.name === "string" && doc.name.length > 0) {
    record.name = doc.name;
  }
  if (typeof doc.hashedPassword === "string" && doc.hashedPassword !== "") {
    record.hashedPassword = doc.hashedPassword;
  }
  if (onboarding) {
    record.onboarding = onboarding;
  }
  return record;
}

export function pgUserToRecord(row: UserRow): UserRecord {
  const onboarding = normalizeOnboarding({
    completedAt: row.onboardingCompletedAt,
    companySize: row.onboardingCompanySize,
    role: row.onboardingRole,
    primaryDatabase: row.onboardingPrimaryDatabase,
    dataWarehouse: row.onboardingDataWarehouse,
  });
  const id = row.id.toLowerCase();
  const record: UserRecord = {
    id,
    _id: id,
    email: row.email,
    emailVerified: row.emailVerified,
    createdAt: coerceDate(row.createdAt),
    updatedAt: coerceDate(row.updatedAt),
  };
  if (row.legacyId != null) {
    record.legacyId = row.legacyId;
  }
  if (row.name != null && row.name.length > 0) {
    record.name = row.name;
  }
  if (row.hashedPassword != null) {
    record.hashedPassword = row.hashedPassword;
  }
  if (onboarding) {
    record.onboarding = onboarding;
  }
  return record;
}

export function userRecordToPgInsert(record: UserRecord): NewUserRow {
  const onboarding = normalizeOnboarding(record.onboarding);
  const pgId = deriveUserUuidv7(record.id, record.createdAt);
  const legacyId = record.legacyId ?? record.id;
  return {
    id: pgId,
    legacyId,
    email: normalizeEmailKey(record.email),
    name: record.name ?? null,
    hashedPassword: record.hashedPassword ?? null,
    emailVerified: record.emailVerified,
    onboardingCompletedAt: onboarding?.completedAt ?? null,
    onboardingCompanySize: onboarding?.companySize ?? null,
    onboardingRole: onboarding?.role ?? null,
    onboardingPrimaryDatabase: onboarding?.primaryDatabase ?? null,
    onboardingDataWarehouse: onboarding?.dataWarehouse ?? null,
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

/**
 * Canonical projection of a `UserRecord` for Stage 3/4 shadow comparison & parity
 * verification so a legacy Mongo user (`_id = 15-char Lucia / UUIDv4`) and its
 * Postgres row (`id = legacyUserIdToUuidv7(...)`, `legacyId = _id`) compare 100% equal.
 */
export function canonicalizeUserForCompare(
  record: UserRecord | null,
): Record<string, unknown> | null {
  if (!record) return null;
  const canonicalId = deriveUserUuidv7(record.id, record.createdAt);
  return {
    id: canonicalId,
    email: normalizeEmailKey(record.email),
    name: record.name,
    hashedPassword: record.hashedPassword,
    emailVerified: record.emailVerified,
    onboarding: normalizeOnboarding(record.onboarding),
    createdAt: record.createdAt,
    updatedAt: record.updatedAt,
  };
}

export function canonicalizeUsersForCompare(
  records: readonly UserRecord[],
): Array<Record<string, unknown>> {
  return records
    .map(r => canonicalizeUserForCompare(r))
    .filter((r): r is Record<string, unknown> => r !== null)
    .sort((a, b) => String(a.id).localeCompare(String(b.id)));
}

export interface MongoAttributionLike {
  _id: string;
  sid?: string | null;
  gclid?: string | null;
  signupMethod: "email" | "google" | "github";
  country?: string | null;
  firstTouch?: Record<string, unknown> | null;
  lastTouch?: Record<string, unknown> | null;
  capturedAt?: Date | string;
}

export function mongoAttributionToRecord(
  doc: MongoAttributionLike,
): UserAttributionRecord {
  const record: UserAttributionRecord = {
    userId: String(doc._id),
    signupMethod: doc.signupMethod,
    firstTouch: sanitizeTouchPayload(doc.firstTouch),
    lastTouch: sanitizeTouchPayload(doc.lastTouch),
    capturedAt: coerceDate(doc.capturedAt),
  };
  if (doc.sid != null) record.sid = doc.sid;
  if (doc.gclid != null) record.gclid = doc.gclid;
  if (doc.country != null) record.country = doc.country;
  return record;
}

export function pgAttributionToRecord(
  row: UserAttributionRow,
): UserAttributionRecord {
  const record: UserAttributionRecord = {
    userId: row.userId.toLowerCase(),
    signupMethod: row.signupMethod,
    firstTouch: sanitizeTouchPayload(row.firstTouch),
    lastTouch: sanitizeTouchPayload(row.lastTouch),
    capturedAt: coerceDate(row.capturedAt),
  };
  if (row.sid != null) record.sid = row.sid;
  if (row.gclid != null) record.gclid = row.gclid;
  if (row.country != null) record.country = row.country;
  return record;
}

export function attributionRecordToPgInsert(
  record: UserAttributionRecord,
  pgUserUuid: string,
): NewUserAttributionRow {
  return {
    userId: pgUserUuid.toLowerCase(),
    sid: record.sid ?? null,
    gclid: record.gclid ?? null,
    signupMethod: record.signupMethod,
    country: record.country ?? null,
    firstTouch: sanitizeTouchPayload(record.firstTouch),
    lastTouch: sanitizeTouchPayload(record.lastTouch),
    capturedAt: record.capturedAt,
  };
}

export interface MongoOAuthAccountLike {
  _id: Types.ObjectId | string;
  userId: string;
  provider: "google" | "github";
  providerUserId: string;
  email?: string | null;
  createdAt?: Date | string;
}

export function oauthIdToPgUuid(id: string): string {
  const parsed = parseEntityId(id);
  if (!parsed) {
    throw new Error(`Invalid OAuthAccount id: ${JSON.stringify(id)}`);
  }
  return parsed.uuid;
}

export function mongoOAuthAccountToRecord(
  doc: MongoOAuthAccountLike,
): OAuthAccountRecord {
  const rawId =
    typeof doc._id === "string" ? doc._id : doc._id.toHexString().toLowerCase();
  const id = isObjectIdHex(rawId) ? rawId.toLowerCase() : rawId;
  const record: OAuthAccountRecord = {
    id,
    userId: String(doc.userId),
    provider: doc.provider,
    providerUserId: doc.providerUserId,
    createdAt: coerceDate(doc.createdAt),
  };
  if (doc.email != null) {
    record.email = doc.email;
  }
  return record;
}

export function pgOAuthAccountToRecord(
  row: OAuthAccountRow,
): OAuthAccountRecord {
  const record: OAuthAccountRecord = {
    id: toWireId(row.id),
    userId: row.userId.toLowerCase(),
    provider: row.provider,
    providerUserId: row.providerUserId,
    createdAt: coerceDate(row.createdAt),
  };
  if (row.email != null) {
    record.email = row.email;
  }
  return record;
}

export function oauthAccountRecordToPgInsert(
  record: OAuthAccountRecord,
  pgUserUuid: string,
): NewOAuthAccountRow {
  return {
    id: oauthIdToPgUuid(record.id),
    userId: pgUserUuid.toLowerCase(),
    provider: record.provider,
    providerUserId: record.providerUserId,
    email: record.email ?? null,
    createdAt: record.createdAt,
  };
}

export interface MongoSessionLike {
  _id: string;
  userId: string;
  expiresAt: Date | string;
  activeWorkspaceId?: string | null;
}

/**
 * Convert a session's optional `activeWorkspaceId` into a Postgres UUID,
 * returning `null` safely if absent or not a valid ObjectId/UUID string.
 */
export function sessionWorkspaceIdToPgUuid(
  activeWorkspaceId: string | null | undefined,
): string | null {
  if (!activeWorkspaceId) return null;
  const parsed = parseEntityId(activeWorkspaceId);
  return parsed ? parsed.uuid : null;
}

/** Normalize an incoming workspace ID to wire format (24-hex ObjectId if in ObjectId subspace). */
export function normalizeWorkspaceWireId(
  activeWorkspaceId: string | null | undefined,
): string | undefined {
  if (!activeWorkspaceId) return undefined;
  const parsed = parseEntityId(activeWorkspaceId);
  if (parsed) {
    return parsed.oid ?? parsed.uuid;
  }
  return activeWorkspaceId;
}

export function mongoSessionToRecord(doc: MongoSessionLike): SessionRecord {
  const record: SessionRecord = {
    id: String(doc._id),
    userId: String(doc.userId),
    expiresAt: coerceDate(doc.expiresAt),
  };
  const wsId = normalizeWorkspaceWireId(doc.activeWorkspaceId);
  if (wsId !== undefined) {
    record.activeWorkspaceId = wsId;
  }
  return record;
}

export function pgSessionToRecord(
  row: SessionRow,
  rawToken: string,
): SessionRecord {
  const record: SessionRecord = {
    id: rawToken,
    tokenHash: row.tokenHash,
    userId: row.userId.toLowerCase(),
    expiresAt: coerceDate(row.expiresAt),
    createdAt: coerceDate(row.createdAt),
    updatedAt: coerceDate(row.updatedAt),
  };
  const wsId = optionalToWireId(row.activeWorkspaceId);
  if (wsId != null) {
    record.activeWorkspaceId = wsId;
  }
  return record;
}

export interface MongoEmailVerificationLike {
  _id: string;
  email?: string | null;
  code?: string | null;
  type: "registration" | "link_password" | "password_reset";
  expiresAt: Date | string;
  createdAt?: Date | string;
}

export function mongoEmailVerificationToRecord(
  doc: MongoEmailVerificationLike,
): EmailVerificationRecord {
  return {
    id: String(doc._id),
    email: normalizeEmailKey(typeof doc.email === "string" ? doc.email : ""),
    code: typeof doc.code === "string" ? doc.code : "",
    type: doc.type,
    expiresAt: coerceDate(doc.expiresAt),
    createdAt: coerceDate(doc.createdAt),
  };
}

export function pgEmailVerificationToRecord(
  row: EmailVerificationRow,
): EmailVerificationRecord {
  return {
    id: row.id,
    email: row.email,
    code: row.code,
    type: row.type,
    expiresAt: coerceDate(row.expiresAt),
    createdAt: coerceDate(row.createdAt),
  };
}

export function emailVerificationRecordToPgInsert(
  record: EmailVerificationRecord,
): NewEmailVerificationRow {
  return {
    id: record.id,
    email: normalizeEmailKey(record.email),
    code: record.code,
    type: record.type,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  };
}

export interface MongoDesktopAuthCodeLike {
  _id: string;
  userId: string;
  challenge: string;
  expiresAt: Date | string;
  createdAt?: Date | string;
}

export function mongoDesktopAuthCodeToRecord(
  doc: MongoDesktopAuthCodeLike,
): DesktopAuthCodeRecord {
  return {
    id: String(doc._id),
    userId: String(doc.userId),
    challenge: doc.challenge,
    expiresAt: coerceDate(doc.expiresAt),
    createdAt: coerceDate(doc.createdAt),
  };
}

export function pgDesktopAuthCodeToRecord(
  row: DesktopAuthCodeRow,
): DesktopAuthCodeRecord {
  return {
    id: row.id,
    userId: row.userId.toLowerCase(),
    challenge: row.challenge,
    expiresAt: coerceDate(row.expiresAt),
    createdAt: coerceDate(row.createdAt),
  };
}

export function desktopAuthCodeRecordToPgInsert(
  record: DesktopAuthCodeRecord,
  pgUserUuid: string,
): NewDesktopAuthCodeRow {
  return {
    id: record.id,
    userId: pgUserUuid.toLowerCase(),
    challenge: record.challenge,
    expiresAt: record.expiresAt,
    createdAt: record.createdAt,
  };
}

/**
 * Deterministic canonicalizer for array results during shadow comparison
 * so differing Mongo `$in` vs Postgres `IN` return order never raises false diffs.
 */
export function sortRecordsById<T extends { id: string }>(
  records: readonly T[],
): T[] {
  return [...records].sort((a, b) => a.id.localeCompare(b.id));
}

/** Helper to safely convert an ObjectId-compatible string into a Mongo ObjectId hex string. */
export function oauthIdToMongoHex(id: string): string {
  const parsed = parseEntityId(id);
  if (!parsed?.oid) {
    throw new Error(
      `OAuthAccount id cannot be represented as Mongo ObjectId: ${JSON.stringify(id)}`,
    );
  }
  return parsed.oid;
}

export { objectIdToUuid };

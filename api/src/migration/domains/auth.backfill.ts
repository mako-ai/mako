/**
 * Phase 1A (`auth` domain) migration handlers (Decision #3):
 *   - FK-ordered resumable MongoDB -> Postgres backfill (`auth` + 5 per-table sub-domains)
 *   - Chunked parity verifier + `--repair` healer (`auth` + 5 per-table sub-domains)
 *   - Inngest dead-letter sync-retry replay handlers (`pg` and `mongo`)
 *   - Postgres batched TTL reaper rules (`sessions`, `email_verifications`, `desktop_auth_codes`)
 *
 * Decision #3 notes:
 *   - `users.id` is RFC 9562 UUIDv7 (derived deterministically from `legacy_id` + `createdAt`
 *     for legacy 15-char Lucia and UUIDv4 users, or preserved verbatim for UUIDv7 users);
 *     the original Mongo `_id` is stored in `users.legacy_id text UNIQUE`.
 *   - All child `user_id` columns are `uuid REFERENCES users(id) ON DELETE CASCADE`.
 *   - `sessions` start EMPTY in Postgres and are NEVER backfilled or dual-written
 *     (one-time logout on cutover); only the hourly TTL reaper rule is registered for `sessions`.
 *
 * FK backfill order:
 *   1. `users`
 *   2. `user_attributions`   (FK -> users.id)
 *   3. `oauth_accounts`      (FK -> users.id)
 *   4. `email_verifications` (independent)
 *   5. `desktop_auth_codes`  (FK -> users.id)
 */
import { eq, inArray, or } from "drizzle-orm";
import { Types } from "mongoose";
import {
  DesktopAuthCode,
  EmailVerification,
  OAuthAccount,
  User,
  UserAttribution,
} from "../../database/schema";
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import {
  isObjectIdHex,
  isUuidString,
  objectIdToUuid,
  uuidToObjectId,
} from "../../database/pg/id-codec";
import {
  desktopAuthCodes,
  emailVerifications,
  oauthAccounts,
  userAttributions,
  users,
} from "../../database/pg/schema/auth";
import { registerSyncRetryHandler } from "../../inngest/functions/migration/sync-retry";
import { loggers } from "../../logging";
import {
  AUTH_SHADOW_OPTIONS,
  MongoAuthRepository,
  PgAuthRepository,
  canonicalizeUserForCompare,
  deriveUserUuidv7,
  mongoAttributionToRecord,
  mongoDesktopAuthCodeToRecord,
  mongoEmailVerificationToRecord,
  mongoOAuthAccountToRecord,
  mongoUserToRecord,
  normalizeEmailKey,
  oauthIdToPgUuid,
  pgAttributionToRecord,
  pgDesktopAuthCodeToRecord,
  pgEmailVerificationToRecord,
  pgOAuthAccountToRecord,
  pgUserToRecord,
  type DesktopAuthCodeRecord,
  type EmailVerificationRecord,
  type EmailVerificationType,
  type MongoAttributionLike,
  type MongoDesktopAuthCodeLike,
  type MongoEmailVerificationLike,
  type MongoOAuthAccountLike,
  type MongoUserLike,
  type OAuthAccountRecord,
  type UserAttributionRecord,
  type UserRecord,
} from "../../repositories/auth";
import {
  registerBackfillDomain,
  type BackfillDomainHandler,
  type BackfillItem,
  type BackfillValidationResult,
} from "../backfill";
import { recordMigrationTombstone } from "../router";
import { registerTtlRule } from "../ttl-reaper";
import type { SyncRetryEventData } from "../types";
import {
  registerVerifierDomain,
  type VerifierDomainHandler,
  type VerifierMongoRecord,
} from "../verifier";

const logger = loggers.migration();

export type AuthMigratedTableName =
  | "users"
  | "user_attributions"
  | "oauth_accounts"
  | "email_verifications"
  | "desktop_auth_codes";

interface AuthStageMeta {
  stage: number;
  table: AuthMigratedTableName;
  collection: string;
}

const AUTH_STAGES: readonly AuthStageMeta[] = [
  { stage: 1, table: "users", collection: "users" },
  { stage: 2, table: "user_attributions", collection: "user_attributions" },
  { stage: 3, table: "oauth_accounts", collection: "oauthaccounts" },
  { stage: 4, table: "email_verifications", collection: "emailverifications" },
  { stage: 5, table: "desktop_auth_codes", collection: "desktopauthcodes" },
] as const;

type AuthBackfillDoc =
  | { table: "users"; record: UserRecord; pgUserUuid: string }
  | {
      table: "user_attributions";
      record: UserAttributionRecord;
      resolvedUserUuid?: string;
    }
  | {
      table: "oauth_accounts";
      record: OAuthAccountRecord;
      resolvedUserUuid?: string;
    }
  | { table: "email_verifications"; record: EmailVerificationRecord }
  | {
      table: "desktop_auth_codes";
      record: DesktopAuthCodeRecord;
      resolvedUserUuid?: string;
    };

const VALID_SIGNUP_METHODS = new Set(["email", "google", "github"]);
const VALID_OAUTH_PROVIDERS = new Set(["google", "github"]);
const VALID_VERIFICATION_TYPES = new Set([
  "registration",
  "link_password",
  "password_reset",
]);

function encodeCompositeCursor(
  stage: number,
  table: AuthMigratedTableName,
  mongoId: string,
): string {
  return `${stage}:${table}:${mongoId}`;
}

function decodeCompositeCursor(
  cursor: string | null,
): { stage: number; table: AuthMigratedTableName; mongoId: string } | null {
  if (!cursor) return null;
  const match = /^([1-5]):([a-z_]+):(.*)$/.exec(cursor);
  if (!match) return null;
  return {
    stage: Number(match[1]),
    table: match[2] as AuthMigratedTableName,
    mongoId: match[3],
  };
}

function encodeVerifierKey(
  table: AuthMigratedTableName,
  pgEntityId: string,
): string {
  return `${table}:${pgEntityId}`;
}

function decodeVerifierKey(
  key: string,
): { table: AuthMigratedTableName; pgEntityId: string } | null {
  const idx = key.indexOf(":");
  if (idx <= 0) return null;
  return {
    table: key.slice(0, idx) as AuthMigratedTableName,
    pgEntityId: key.slice(idx + 1),
  };
}

async function resolvePgUserUuid(
  db: MakoPgDb,
  legacyOrUuid: string,
): Promise<string | null> {
  if (!legacyOrUuid) return null;
  const whereClause = isUuidString(legacyOrUuid)
    ? or(
        eq(users.id, legacyOrUuid.toLowerCase()),
        eq(users.legacyId, legacyOrUuid),
      )
    : eq(users.legacyId, legacyOrUuid);
  const rows = await db
    .select({ id: users.id })
    .from(users)
    .where(whereClause)
    .limit(1);
  return rows[0] ? rows[0].id.toLowerCase() : null;
}

async function resolvePgUserUuidsBatch(
  db: MakoPgDb,
  legacyOrUuids: readonly string[],
): Promise<Map<string, string>> {
  const unique = [...new Set(legacyOrUuids.filter(Boolean))];
  const out = new Map<string, string>();
  if (unique.length === 0) return out;
  const uuidCandidates = unique.filter(isUuidString).map(s => s.toLowerCase());
  const whereClause =
    uuidCandidates.length > 0
      ? or(inArray(users.id, uuidCandidates), inArray(users.legacyId, unique))
      : inArray(users.legacyId, unique);
  const rows = await db
    .select({ id: users.id, legacyId: users.legacyId })
    .from(users)
    .where(whereClause);
  for (const row of rows) {
    const pgId = row.id.toLowerCase();
    out.set(pgId, pgId);
    if (row.legacyId) {
      out.set(row.legacyId, pgId);
    }
  }
  return out;
}

async function fetchStageBackfillItems(
  meta: AuthStageMeta,
  afterId: string | null,
  limit: number,
  composite: boolean,
): Promise<Array<BackfillItem<AuthBackfillDoc>>> {
  if (limit <= 0) return [];
  const makeCursor = (mongoId: string) =>
    composite ? encodeCompositeCursor(meta.stage, meta.table, mongoId) : mongoId;

  switch (meta.table) {
    case "users": {
      const filter = afterId ? { _id: { $gt: afterId } } : {};
      const docs = await User.find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoUserLike[]>();
      return docs.map(doc => {
        const record = mongoUserToRecord(doc);
        const pgUserUuid = deriveUserUuidv7(record.id, record.createdAt);
        return {
          cursor: makeCursor(record.id),
          entityId: pgUserUuid,
          targetTable: "users",
          collectionName: meta.collection,
          doc: { table: "users", record, pgUserUuid },
        };
      });
    }

    case "user_attributions": {
      const filter = afterId ? { _id: { $gt: afterId } } : {};
      const docs = await UserAttribution.find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoAttributionLike[]>();
      return docs.map(doc => {
        const record = mongoAttributionToRecord(doc);
        return {
          cursor: makeCursor(record.userId),
          entityId: record.userId,
          targetTable: "user_attributions",
          collectionName: meta.collection,
          doc: { table: "user_attributions", record },
        };
      });
    }

    case "oauth_accounts": {
      // Use the raw MongoDB driver collection so non-ObjectId legacy string `_id`s
      // advance monotonically in native BSON order (String < ObjectId) without
      // Mongoose CastError. Because MongoDB `$gt` uses same-type bracketing, a
      // string cursor explicitly includes `$type: "objectId"` via `$or` so
      // pagination transitions seamlessly from legacy string `_id`s into ObjectIds.
      const filter: Record<string, unknown> = afterId
        ? isObjectIdHex(afterId)
          ? { _id: { $gt: new Types.ObjectId(afterId) } }
          : {
              $or: [{ _id: { $gt: afterId } }, { _id: { $type: "objectId" } }],
            }
        : {};
      const docs = (await OAuthAccount.collection
        .find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .toArray()) as unknown as MongoOAuthAccountLike[];
      return docs.map(doc => {
        const record = mongoOAuthAccountToRecord(doc);
        const entityId = isObjectIdHex(record.id)
          ? objectIdToUuid(record.id)
          : record.id;
        return {
          cursor: makeCursor(record.id),
          entityId,
          targetTable: "oauth_accounts",
          collectionName: meta.collection,
          doc: { table: "oauth_accounts", record },
        };
      });
    }

    case "email_verifications": {
      const filter = afterId ? { _id: { $gt: afterId } } : {};
      const docs = await EmailVerification.find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoEmailVerificationLike[]>();
      return docs.map(doc => {
        const record = mongoEmailVerificationToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: record.id,
          targetTable: "email_verifications",
          collectionName: meta.collection,
          doc: { table: "email_verifications", record },
        };
      });
    }

    case "desktop_auth_codes": {
      const filter = afterId ? { _id: { $gt: afterId } } : {};
      const docs = await DesktopAuthCode.find(filter)
        .sort({ _id: 1 })
        .limit(limit)
        .lean<MongoDesktopAuthCodeLike[]>();
      return docs.map(doc => {
        const record = mongoDesktopAuthCodeToRecord(doc);
        return {
          cursor: makeCursor(record.id),
          entityId: record.id,
          targetTable: "desktop_auth_codes",
          collectionName: meta.collection,
          doc: { table: "desktop_auth_codes", record },
        };
      });
    }
  }
}

async function validateAuthBackfillItem(
  item: BackfillItem<AuthBackfillDoc>,
  db: MakoPgDb,
  batchUserMap: Map<string, string>,
): Promise<BackfillValidationResult> {
  const { doc } = item;
  switch (doc.table) {
    case "users": {
      if (!doc.record.id || !normalizeEmailKey(doc.record.email)) {
        return {
          ok: false,
          reason: "invalid_user_missing_email",
          sanitizedPayload: { userId: doc.record.id },
        };
      }
      batchUserMap.set(doc.record.id, doc.pgUserUuid);
      batchUserMap.set(doc.pgUserUuid, doc.pgUserUuid);
      return { ok: true };
    }

    case "user_attributions": {
      if (!VALID_SIGNUP_METHODS.has(doc.record.signupMethod)) {
        return {
          ok: false,
          reason: "invalid_signup_method",
          sanitizedPayload: {
            userId: doc.record.userId,
            signupMethod: doc.record.signupMethod,
          },
        };
      }
      const pgUserUuid =
        batchUserMap.get(doc.record.userId) ??
        (await resolvePgUserUuid(db, doc.record.userId));
      if (!pgUserUuid) {
        return {
          ok: false,
          reason: "orphaned_user_missing",
          sanitizedPayload: {
            table: "user_attributions",
            userId: doc.record.userId,
          },
        };
      }
      doc.resolvedUserUuid = pgUserUuid;
      return { ok: true };
    }

    case "oauth_accounts": {
      if (!isObjectIdHex(doc.record.id)) {
        return {
          ok: false,
          reason: "invalid_oauth_account_object_id",
          sanitizedPayload: {
            id: doc.record.id,
            provider: doc.record.provider,
          },
        };
      }
      if (!VALID_OAUTH_PROVIDERS.has(doc.record.provider)) {
        return {
          ok: false,
          reason: "invalid_oauth_provider",
          sanitizedPayload: {
            id: doc.record.id,
            provider: doc.record.provider,
          },
        };
      }
      const pgUserUuid =
        batchUserMap.get(doc.record.userId) ??
        (await resolvePgUserUuid(db, doc.record.userId));
      if (!pgUserUuid) {
        return {
          ok: false,
          reason: "orphaned_user_missing",
          sanitizedPayload: {
            table: "oauth_accounts",
            userId: doc.record.userId,
            provider: doc.record.provider,
          },
        };
      }
      doc.resolvedUserUuid = pgUserUuid;
      return { ok: true };
    }

    case "email_verifications": {
      if (
        !normalizeEmailKey(doc.record.email) ||
        !VALID_VERIFICATION_TYPES.has(doc.record.type)
      ) {
        return {
          ok: false,
          reason: "invalid_email_verification",
          sanitizedPayload: { id: doc.record.id, type: doc.record.type },
        };
      }
      return { ok: true };
    }

    case "desktop_auth_codes": {
      const pgUserUuid =
        batchUserMap.get(doc.record.userId) ??
        (await resolvePgUserUuid(db, doc.record.userId));
      if (!pgUserUuid) {
        return {
          ok: false,
          reason: "orphaned_user_missing",
          sanitizedPayload: {
            table: "desktop_auth_codes",
            userId: doc.record.userId,
          },
        };
      }
      doc.resolvedUserUuid = pgUserUuid;
      return { ok: true };
    }
  }
}

async function upsertAuthBackfillItems(
  items: Array<BackfillItem<AuthBackfillDoc>>,
  db: MakoPgDb,
  pgRepo: PgAuthRepository,
): Promise<number> {
  let upserted = 0;
  for (const item of items) {
    const { doc } = item;
    let wrote = false;
    switch (doc.table) {
      case "users":
        wrote = await pgRepo.upsertUserWithGuard(doc.record, db);
        break;
      case "user_attributions":
        if (doc.resolvedUserUuid) {
          wrote = await pgRepo.upsertAttributionIgnoreConflict(
            doc.record,
            doc.resolvedUserUuid,
            db,
          );
        }
        break;
      case "oauth_accounts":
        if (doc.resolvedUserUuid) {
          wrote = await pgRepo.upsertOAuthAccountIdempotent(
            doc.record,
            doc.resolvedUserUuid,
            db,
          );
        }
        break;
      case "email_verifications":
        wrote = await pgRepo.upsertEmailVerificationIdempotent(doc.record, db);
        break;
      case "desktop_auth_codes":
        if (doc.resolvedUserUuid) {
          wrote = await pgRepo.upsertDesktopAuthCodeIdempotent(
            doc.record,
            doc.resolvedUserUuid,
            db,
          );
        }
        break;
    }
    if (wrote) upserted += 1;
  }
  return upserted;
}

/**
 * Build the composite FK-ordered `"auth"` backfill handler covering all 5 migrated auth tables.
 * (`sessions` is intentionally excluded per Decision #3 — starts empty in Postgres.)
 */
export function createAuthBackfillHandler(): BackfillDomainHandler<AuthBackfillDoc> {
  const pgRepo = new PgAuthRepository();
  const batchUserMap = new Map<string, string>();

  return {
    domain: "auth",
    collectionName: "users",
    targetTable: "users",
    async fetchBatch({ afterCursor, limit }) {
      batchUserMap.clear();
      const parsed = decodeCompositeCursor(afterCursor);
      const startStage = parsed ? parsed.stage : 1;
      const items: Array<BackfillItem<AuthBackfillDoc>> = [];

      for (const meta of AUTH_STAGES) {
        if (meta.stage < startStage) continue;
        const remaining = limit - items.length;
        if (remaining <= 0) break;

        const stageAfter =
          parsed && parsed.stage === meta.stage ? parsed.mongoId : null;
        const batch = await fetchStageBackfillItems(
          meta,
          stageAfter,
          remaining,
          true,
        );
        items.push(...batch);
      }

      return items;
    },
    validate(item, db) {
      return validateAuthBackfillItem(item, db, batchUserMap);
    },
    upsertBatch(items, db) {
      return upsertAuthBackfillItems(items, db, pgRepo);
    },
  };
}

/**
 * Build a single-table sub-domain backfill handler (e.g. `auth:users`, `auth:oauth_accounts`).
 */
export function createAuthTableBackfillHandler(
  meta: AuthStageMeta,
): BackfillDomainHandler<AuthBackfillDoc> {
  const pgRepo = new PgAuthRepository();
  const batchUserMap = new Map<string, string>();

  return {
    domain: `auth:${meta.table}`,
    collectionName: meta.collection,
    targetTable: meta.table,
    async fetchBatch({ afterCursor, limit }) {
      batchUserMap.clear();
      return fetchStageBackfillItems(meta, afterCursor, limit, false);
    },
    validate(item, db) {
      return validateAuthBackfillItem(item, db, batchUserMap);
    },
    upsertBatch(items, db) {
      return upsertAuthBackfillItems(items, db, pgRepo);
    },
  };
}

// ── Parity verifier (+ --repair) ────────────────────────────────────────────

async function fetchPgRecordsForTable(
  table: AuthMigratedTableName,
  ids: string[],
  db: MakoPgDb,
): Promise<Map<string, unknown>> {
  const out = new Map<string, unknown>();
  if (ids.length === 0) return out;

  switch (table) {
    case "users": {
      const uuidIds = ids.filter(isUuidString).map(id => id.toLowerCase());
      if (uuidIds.length === 0) return out;
      const rows = await db
        .select()
        .from(users)
        .where(inArray(users.id, uuidIds));
      for (const row of rows) {
        out.set(
          row.id.toLowerCase(),
          canonicalizeUserForCompare(pgUserToRecord(row)),
        );
      }
      return out;
    }

    case "user_attributions": {
      const uuidIds = ids.filter(isUuidString).map(id => id.toLowerCase());
      if (uuidIds.length === 0) return out;
      const rows = await db
        .select()
        .from(userAttributions)
        .where(inArray(userAttributions.userId, uuidIds));
      for (const row of rows) {
        out.set(row.userId.toLowerCase(), pgAttributionToRecord(row));
      }
      return out;
    }

    case "oauth_accounts": {
      const uuidIds = ids.filter(isUuidString).map(id => id.toLowerCase());
      if (uuidIds.length === 0) return out;
      const rows = await db
        .select()
        .from(oauthAccounts)
        .where(inArray(oauthAccounts.id, uuidIds));
      for (const row of rows) {
        out.set(row.id.toLowerCase(), pgOAuthAccountToRecord(row));
      }
      return out;
    }

    case "email_verifications": {
      const rows = await db
        .select()
        .from(emailVerifications)
        .where(inArray(emailVerifications.id, ids));
      for (const row of rows) {
        out.set(row.id, pgEmailVerificationToRecord(row));
      }
      return out;
    }

    case "desktop_auth_codes": {
      const rows = await db
        .select()
        .from(desktopAuthCodes)
        .where(inArray(desktopAuthCodes.id, ids));
      for (const row of rows) {
        out.set(row.id, pgDesktopAuthCodeToRecord(row));
      }
      return out;
    }
  }
}

async function listAllPgIdsForTable(
  table: AuthMigratedTableName,
  db: MakoPgDb,
): Promise<string[]> {
  switch (table) {
    case "users":
      return (await db.select({ id: users.id }).from(users)).map(r =>
        r.id.toLowerCase(),
      );
    case "user_attributions":
      return (
        await db.select({ id: userAttributions.userId }).from(userAttributions)
      ).map(r => r.id.toLowerCase());
    case "oauth_accounts":
      return (
        await db.select({ id: oauthAccounts.id }).from(oauthAccounts)
      ).map(r => r.id.toLowerCase());
    case "email_verifications":
      return (
        await db.select({ id: emailVerifications.id }).from(emailVerifications)
      ).map(r => r.id);
    case "desktop_auth_codes":
      return (
        await db.select({ id: desktopAuthCodes.id }).from(desktopAuthCodes)
      ).map(r => r.id);
  }
}

/**
 * Resolve Mongo legacy user IDs in a verifier batch into their canonical PG UUIDs
 * (using PG `users` table first, falling back to Mongo `User` createdAt derivation).
 */
async function resolveVerifierUserMap(
  items: Array<BackfillItem<AuthBackfillDoc>>,
  db: MakoPgDb,
): Promise<Map<string, string>> {
  const needed = new Set<string>();
  const map = new Map<string, string>();
  for (const item of items) {
    const { doc } = item;
    if (doc.table === "users") {
      map.set(doc.record.id, doc.pgUserUuid);
      map.set(doc.pgUserUuid, doc.pgUserUuid);
    } else if (
      doc.table === "user_attributions" ||
      doc.table === "oauth_accounts" ||
      doc.table === "desktop_auth_codes"
    ) {
      needed.add(doc.record.userId);
    }
  }

  const unresolved = [...needed].filter(id => !map.has(id));
  if (unresolved.length > 0) {
    const fromPg = await resolvePgUserUuidsBatch(db, unresolved);
    for (const [k, v] of fromPg) map.set(k, v);
  }

  const stillUnresolved = [...needed].filter(id => !map.has(id));
  if (stillUnresolved.length > 0) {
    const mongoUsers = await User.find({ _id: { $in: stillUnresolved } })
      .select("_id createdAt")
      .lean<Array<{ _id: string; createdAt?: Date | string }>>();
    for (const u of mongoUsers) {
      const id = String(u._id);
      const createdAt = u.createdAt ? new Date(u.createdAt) : undefined;
      map.set(id, deriveUserUuidv7(id, createdAt));
    }
  }

  return map;
}

function buildVerifierRecord(
  item: BackfillItem<AuthBackfillDoc>,
  userMap: Map<string, string>,
  composite: boolean,
): VerifierMongoRecord {
  const { doc } = item;
  let pgEntityId = item.entityId;
  let record: unknown;

  switch (doc.table) {
    case "users":
      pgEntityId = doc.pgUserUuid;
      record = canonicalizeUserForCompare(doc.record);
      break;

    case "user_attributions": {
      const resolvedUserUuid = userMap.get(doc.record.userId) ?? doc.record.userId;
      pgEntityId = resolvedUserUuid;
      record = { ...doc.record, userId: resolvedUserUuid };
      break;
    }

    case "oauth_accounts": {
      const resolvedUserUuid = userMap.get(doc.record.userId) ?? doc.record.userId;
      record = { ...doc.record, userId: resolvedUserUuid };
      break;
    }

    case "email_verifications":
      record = doc.record;
      break;

    case "desktop_auth_codes": {
      const resolvedUserUuid = userMap.get(doc.record.userId) ?? doc.record.userId;
      record = { ...doc.record, userId: resolvedUserUuid };
      break;
    }
  }

  return {
    cursor: item.cursor,
    entityId: composite ? encodeVerifierKey(doc.table, pgEntityId) : pgEntityId,
    targetTable: doc.table,
    tombstoneId: pgEntityId,
    record,
  };
}

async function findMongoUserByPgUuid(
  pgUuid: string,
  db: MakoPgDb,
): Promise<MongoUserLike | null> {
  // Fast path: check PG legacy_id first, then direct Mongo _id === pgUuid
  const pgRow = await db
    .select({ legacyId: users.legacyId })
    .from(users)
    .where(eq(users.id, pgUuid.toLowerCase()))
    .limit(1);
  if (pgRow[0]?.legacyId) {
    const byLegacy = await User.findById(
      pgRow[0].legacyId,
    ).lean<MongoUserLike | null>();
    if (byLegacy) return byLegacy;
  }
  const direct = await User.findById(pgUuid).lean<MongoUserLike | null>();
  if (direct) return direct;
  // Fallback scan when the user row was deleted from PG before --repair
  const all = await User.find({}).lean<MongoUserLike[]>();
  for (const doc of all) {
    const rec = mongoUserToRecord(doc);
    if (deriveUserUuidv7(rec.id, rec.createdAt) === pgUuid.toLowerCase()) {
      return doc;
    }
  }
  return null;
}

async function repairSingleAuthRecord(
  table: AuthMigratedTableName,
  pgEntityId: string,
  db: MakoPgDb,
  pgRepo: PgAuthRepository,
): Promise<boolean> {
  switch (table) {
    case "users": {
      const doc = await findMongoUserByPgUuid(pgEntityId, db);
      if (!doc) return false;
      const record = mongoUserToRecord(doc);
      const pgUuid = deriveUserUuidv7(record.id, record.createdAt);
      const existing = await pgRepo.findUserById(pgUuid, db);
      if (existing) {
        await db
          .update(users)
          .set({
            email: record.email,
            name: record.name ?? null,
            hashedPassword: record.hashedPassword ?? null,
            emailVerified: record.emailVerified,
            onboardingCompletedAt: record.onboarding?.completedAt ?? null,
            onboardingCompanySize: record.onboarding?.companySize ?? null,
            onboardingRole: record.onboarding?.role ?? null,
            onboardingPrimaryDatabase:
              record.onboarding?.primaryDatabase ?? null,
            onboardingDataWarehouse: record.onboarding?.dataWarehouse ?? null,
            updatedAt: record.updatedAt,
          })
          .where(eq(users.id, pgUuid));
        return true;
      }
      return pgRepo.upsertUserWithGuard(record, db);
    }

    case "user_attributions": {
      const pgUser = await pgRepo.findUserById(pgEntityId, db);
      if (!pgUser) return false;
      const mongoId = pgUser.legacyId ?? pgUser.id;
      const doc = await UserAttribution.findById(
        mongoId,
      ).lean<MongoAttributionLike | null>();
      if (!doc) return false;
      const record = mongoAttributionToRecord(doc);
      await db
        .insert(userAttributions)
        .values({
          userId: pgUser.id,
          sid: record.sid ?? null,
          gclid: record.gclid ?? null,
          signupMethod: record.signupMethod,
          country: record.country ?? null,
          firstTouch: record.firstTouch,
          lastTouch: record.lastTouch,
          capturedAt: record.capturedAt,
        })
        .onConflictDoUpdate({
          target: userAttributions.userId,
          set: {
            sid: record.sid ?? null,
            gclid: record.gclid ?? null,
            signupMethod: record.signupMethod,
            country: record.country ?? null,
            firstTouch: record.firstTouch,
            lastTouch: record.lastTouch,
            capturedAt: record.capturedAt,
          },
        });
      return true;
    }

    case "oauth_accounts": {
      const oidHex = uuidToObjectId(pgEntityId);
      const doc = await OAuthAccount.findById(
        new Types.ObjectId(oidHex),
      ).lean<MongoOAuthAccountLike | null>();
      if (!doc) return false;
      const record = mongoOAuthAccountToRecord(doc);
      const pgUserUuid = await resolvePgUserUuid(db, record.userId);
      if (!pgUserUuid) return false;
      return pgRepo.upsertOAuthAccountIdempotent(record, pgUserUuid, db);
    }

    case "email_verifications": {
      const doc = await EmailVerification.findById(
        pgEntityId,
      ).lean<MongoEmailVerificationLike | null>();
      if (!doc) return false;
      return pgRepo.upsertEmailVerificationIdempotent(
        mongoEmailVerificationToRecord(doc),
        db,
      );
    }

    case "desktop_auth_codes": {
      const doc = await DesktopAuthCode.findById(
        pgEntityId,
      ).lean<MongoDesktopAuthCodeLike | null>();
      if (!doc) return false;
      const record = mongoDesktopAuthCodeToRecord(doc);
      const pgUserUuid = await resolvePgUserUuid(db, record.userId);
      if (!pgUserUuid) return false;
      return pgRepo.upsertDesktopAuthCodeIdempotent(record, pgUserUuid, db);
    }
  }
}

export function createAuthVerifierHandler(): VerifierDomainHandler {
  const pgRepo = new PgAuthRepository();

  return {
    domain: "auth",
    targetTable: "users",
    compareOptions: AUTH_SHADOW_OPTIONS,
    async fetchMongoBatch({ afterCursor, limit }) {
      const parsed = decodeCompositeCursor(afterCursor);
      const startStage = parsed ? parsed.stage : 1;
      const items: Array<BackfillItem<AuthBackfillDoc>> = [];

      for (const meta of AUTH_STAGES) {
        if (meta.stage < startStage) continue;
        const remaining = limit - items.length;
        if (remaining <= 0) break;

        const stageAfter =
          parsed && parsed.stage === meta.stage ? parsed.mongoId : null;
        const batch = await fetchStageBackfillItems(
          meta,
          stageAfter,
          remaining,
          true,
        );
        items.push(...batch);
      }

      const db = getPgDb();
      const userMap = await resolveVerifierUserMap(items, db);
      return items.map(item => buildVerifierRecord(item, userMap, true));
    },
    async fetchPgByIds(entityIds, db) {
      const byTable = new Map<AuthMigratedTableName, string[]>();
      for (const key of entityIds) {
        const decoded = decodeVerifierKey(key);
        if (!decoded) continue;
        const list = byTable.get(decoded.table);
        if (list) list.push(decoded.pgEntityId);
        else byTable.set(decoded.table, [decoded.pgEntityId]);
      }

      const out = new Map<string, unknown>();
      await Promise.all(
        [...byTable.entries()].map(async ([table, ids]) => {
          const tableMap = await fetchPgRecordsForTable(table, ids, db);
          for (const [id, rec] of tableMap) {
            out.set(encodeVerifierKey(table, id), rec);
          }
        }),
      );
      return out;
    },
    async findExtraPgIds({ seenEntityIds, db }) {
      const extras: string[] = [];
      for (const meta of AUTH_STAGES) {
        const ids = await listAllPgIdsForTable(meta.table, db);
        for (const id of ids) {
          const key = encodeVerifierKey(meta.table, id);
          if (!seenEntityIds.has(key)) {
            extras.push(key);
          }
        }
      }
      return extras;
    },
    async repair({ entityIds, db }) {
      const parsed = entityIds
        .map(decodeVerifierKey)
        .filter((v): v is NonNullable<typeof v> => v !== null);
      // Repair users first so child repairs satisfy FK constraints.
      parsed.sort((a, b) => {
        const aRank = a.table === "users" ? 0 : 1;
        const bRank = b.table === "users" ? 0 : 1;
        return aRank - bRank;
      });
      let repaired = 0;
      for (const entry of parsed) {
        if (
          await repairSingleAuthRecord(entry.table, entry.pgEntityId, db, pgRepo)
        ) {
          repaired += 1;
        }
      }
      return repaired;
    },
  };
}

export function createAuthTableVerifierHandler(
  meta: AuthStageMeta,
): VerifierDomainHandler {
  const pgRepo = new PgAuthRepository();

  return {
    domain: `auth:${meta.table}`,
    targetTable: meta.table,
    compareOptions: AUTH_SHADOW_OPTIONS,
    async fetchMongoBatch({ afterCursor, limit }) {
      const items = await fetchStageBackfillItems(
        meta,
        afterCursor,
        limit,
        false,
      );
      const userMap = await resolveVerifierUserMap(items, getPgDb());
      return items.map(item => buildVerifierRecord(item, userMap, false));
    },
    fetchPgByIds(entityIds, db) {
      return fetchPgRecordsForTable(meta.table, entityIds, db);
    },
    async findExtraPgIds({ seenEntityIds, db }) {
      const ids = await listAllPgIdsForTable(meta.table, db);
      return ids.filter(id => !seenEntityIds.has(id));
    },
    async repair({ entityIds, db }) {
      let repaired = 0;
      for (const id of entityIds) {
        if (await repairSingleAuthRecord(meta.table, id, db, pgRepo)) {
          repaired += 1;
        }
      }
      return repaired;
    },
  };
}

// ── Inngest sync-retry replay handlers (PG secondary & Mongo secondary) ────
// Sessions are NEVER dual-written (Decision #3), so zero session tokens ever
// appear in sync-retry payloads or handlers.

export async function replayAuthWriteToPg(
  data: SyncRetryEventData,
  db: MakoPgDb = getPgDb(),
): Promise<void> {
  const pgRepo = new PgAuthRepository({ getDb: () => db });
  const payload = data.payload ?? {};

  switch (data.operation) {
    case "createUser":
    case "updateUser": {
      const userId = String(payload.userId ?? data.entityId);
      const doc = await User.findById(userId).lean<MongoUserLike | null>();
      if (doc) {
        await pgRepo.upsertUserWithGuard(mongoUserToRecord(doc), db);
      }
      return;
    }

    case "upsertAttributionOnce": {
      const userId = String(payload.userId ?? data.entityId);
      const doc = await UserAttribution.findById(
        userId,
      ).lean<MongoAttributionLike | null>();
      if (!doc) return;
      const pgUserUuid = await resolvePgUserUuid(db, userId);
      if (pgUserUuid) {
        await pgRepo.upsertAttributionIgnoreConflict(
          mongoAttributionToRecord(doc),
          pgUserUuid,
          db,
        );
      }
      return;
    }

    case "createOAuthAccount": {
      const oauthId = String(payload.oauthAccountId ?? data.entityId);
      const doc = isObjectIdHex(oauthId)
        ? await OAuthAccount.findById(
            new Types.ObjectId(oauthId),
          ).lean<MongoOAuthAccountLike | null>()
        : null;
      if (!doc) return;
      const record = mongoOAuthAccountToRecord(doc);
      const pgUserUuid = await resolvePgUserUuid(db, record.userId);
      if (pgUserUuid) {
        await pgRepo.upsertOAuthAccountIdempotent(record, pgUserUuid, db);
      }
      return;
    }

    case "createEmailVerification": {
      const verificationId = String(payload.verificationId ?? data.entityId);
      const doc = await EmailVerification.findById(
        verificationId,
      ).lean<MongoEmailVerificationLike | null>();
      if (doc) {
        await pgRepo.upsertEmailVerificationIdempotent(
          mongoEmailVerificationToRecord(doc),
          db,
        );
      }
      return;
    }

    case "deleteEmailVerificationById": {
      const verificationId = String(payload.verificationId ?? data.entityId);
      await pgRepo.deleteEmailVerificationById(verificationId);
      await recordMigrationTombstone("email_verifications", verificationId, db);
      return;
    }

    case "deleteEmailVerificationsByEmailAndType": {
      const email = String(payload.email ?? "");
      const type = String(payload.type ?? "") as EmailVerificationType;
      if (!email || !VALID_VERIFICATION_TYPES.has(type)) return;
      const pgIds = await pgRepo.deleteEmailVerificationsReturningIds(
        email,
        type,
      );
      for (const id of pgIds) {
        await recordMigrationTombstone("email_verifications", id, db);
      }
      return;
    }

    case "createDesktopAuthCode": {
      const codeHash = String(payload.codeHash ?? data.entityId);
      const doc = await DesktopAuthCode.findById(
        codeHash,
      ).lean<MongoDesktopAuthCodeLike | null>();
      if (!doc) return;
      const record = mongoDesktopAuthCodeToRecord(doc);
      const pgUserUuid = await resolvePgUserUuid(db, record.userId);
      if (pgUserUuid) {
        await pgRepo.upsertDesktopAuthCodeIdempotent(record, pgUserUuid, db);
      }
      return;
    }

    case "redeemAndDeleteDesktopAuthCode": {
      const codeHash = String(payload.codeHash ?? data.entityId);
      await pgRepo.redeemAndDeleteDesktopAuthCode(codeHash);
      await recordMigrationTombstone("desktop_auth_codes", codeHash, db);
      return;
    }

    default:
      logger.warn("Unknown auth sync-retry PG operation; skipping", {
        operation: data.operation,
        entityId: data.entityId,
      });
  }
}

export async function replayAuthWriteToMongo(
  data: SyncRetryEventData,
  db: MakoPgDb = getPgDb(),
): Promise<void> {
  const mongoRepo = new MongoAuthRepository();
  const pgRepo = new PgAuthRepository({ getDb: () => db });
  const payload = data.payload ?? {};

  switch (data.operation) {
    case "createUser":
    case "updateUser": {
      const userId = String(payload.pgUserId ?? payload.userId ?? data.entityId);
      const record = await pgRepo.findUserById(userId, db);
      if (record) {
        await mongoRepo.upsertUserFromRecord(record);
      }
      return;
    }

    case "upsertAttributionOnce": {
      const userId = String(payload.userId ?? data.entityId);
      const pgUser = await pgRepo.findUserById(userId, db);
      const record = await pgRepo.findAttributionByUserId(userId, db);
      if (record) {
        await mongoRepo.upsertAttributionOnce({
          ...record,
          userId: pgUser?.legacyId ?? record.userId,
        });
      }
      return;
    }

    case "createOAuthAccount": {
      const oauthId = String(payload.oauthAccountId ?? data.entityId);
      const record = await pgRepo.findOAuthAccountById(
        oauthIdToPgUuid(oauthId),
        db,
      );
      if (record) {
        const pgUser = await pgRepo.findUserById(record.userId, db);
        await mongoRepo.upsertOAuthAccountFromRecord(
          record,
          pgUser?.legacyId ?? record.userId,
        );
      }
      return;
    }

    case "createEmailVerification": {
      const verificationId = String(payload.verificationId ?? data.entityId);
      const record = await pgRepo.findEmailVerificationById(verificationId, db);
      if (record) {
        await mongoRepo.upsertEmailVerificationFromRecord(record);
      }
      return;
    }

    case "deleteEmailVerificationById": {
      const verificationId = String(payload.verificationId ?? data.entityId);
      await mongoRepo.deleteEmailVerificationById(verificationId);
      return;
    }

    case "deleteEmailVerificationsByEmailAndType": {
      const email = String(payload.email ?? "");
      const type = String(payload.type ?? "") as EmailVerificationType;
      if (email && VALID_VERIFICATION_TYPES.has(type)) {
        await mongoRepo.deleteEmailVerificationsByEmailAndType(email, type);
      }
      return;
    }

    case "createDesktopAuthCode": {
      const codeHash = String(payload.codeHash ?? data.entityId);
      const record = await pgRepo.findDesktopAuthCodeById(codeHash, db);
      if (record) {
        const pgUser = await pgRepo.findUserById(record.userId, db);
        await mongoRepo.upsertDesktopAuthCodeFromRecord(
          record,
          pgUser?.legacyId ?? record.userId,
        );
      }
      return;
    }

    case "redeemAndDeleteDesktopAuthCode": {
      const codeHash = String(payload.codeHash ?? data.entityId);
      await mongoRepo.redeemAndDeleteDesktopAuthCode(codeHash);
      return;
    }

    default:
      logger.warn("Unknown auth sync-retry Mongo operation; skipping", {
        operation: data.operation,
        entityId: data.entityId,
      });
  }
}

/**
 * Register all Phase 1A (`auth`) backfill handlers, parity verifiers, Inngest
 * sync-retry handlers, and Postgres TTL reaper rules. Idempotent.
 */
export function registerAuthMigrationDomain(): void {
  // Composite domain + 5 migrated table sub-domains (sessions excluded per Decision #3)
  registerBackfillDomain(createAuthBackfillHandler());
  registerVerifierDomain(createAuthVerifierHandler());

  for (const meta of AUTH_STAGES) {
    registerBackfillDomain(createAuthTableBackfillHandler(meta));
    registerVerifierDomain(createAuthTableVerifierHandler(meta));
  }

  // Bidirectional Inngest sync-retry handlers (non-session tables only)
  registerSyncRetryHandler("pg", "auth", data => replayAuthWriteToPg(data));
  registerSyncRetryHandler("mongo", "auth", data =>
    replayAuthWriteToMongo(data),
  );

  // Postgres TTL reaper rules (including hashed-token PG sessions created post-cutover)
  registerTtlRule({
    tableName: "sessions",
    timestampColumn: "expires_at",
  });
  registerTtlRule({
    tableName: "email_verifications",
    timestampColumn: "expires_at",
  });
  registerTtlRule({
    tableName: "desktop_auth_codes",
    timestampColumn: "expires_at",
  });
}

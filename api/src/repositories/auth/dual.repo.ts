/**
 * 5-stage dual-run `AuthRepository` powered by `MigrationRouter` (`domain = "auth"`).
 *
 * Decision #3 semantics:
 *   - New users created during dual-write mint ONE RFC 9562 UUIDv7 written to BOTH
 *     Postgres (`id = uuid`, `legacy_id = uuid`) and Mongo (`_id = uuid`).
 *   - Legacy users resolve seamlessly via `users.legacy_id` <-> `users.id` (UUIDv7),
 *     including Stage 4 reverse-sync back to their original Mongo `_id`.
 *   - `sessions` start EMPTY in Postgres (one-time logout on cutover):
 *       * Stages 1–3 (`mongo_only`, `dual_write_mongo_read`, `dual_write_shadow_compare`):
 *         session CRUD runs against Mongo ONLY (zero PG writes, zero raw tokens in Inngest).
 *       * Stages 4–5 (`dual_write_pg_read`, `pg_only`):
 *         session CRUD runs against Postgres hashed-token sessions ONLY (`token_hash = sha256(token)`).
 *   - Records delete tombstones in `migration_tombstones` during Stages 2 & 3 for
 *     migrated collections (`email_verifications`, `desktop_auth_codes`) so in-flight
 *     backfills cannot resurrect deleted rows.
 */
import { randomUUID } from "node:crypto";
import { getPgDb, type MakoPgDb } from "../../database/pg/client";
import {
  generateUuidv7,
  isUuidv7,
  newDualId,
} from "../../database/pg/id-codec";
import { loggers } from "../../logging";
import {
  migrationRouter,
  recordMigrationTombstone,
  type MigrationRouter,
} from "../../migration/router";
import type { ShadowCompareOptions } from "../../migration/types";
import {
  canonicalizeUserForCompare,
  canonicalizeUsersForCompare,
  deriveUserUuidv7,
  normalizeEmailKey,
  sortRecordsById,
} from "./mapper";
import { MongoAuthRepository } from "./mongo.repo";
import { PgAuthRepository } from "./pg.repo";
import type {
  AuthRepository,
  CreateDesktopAuthCodeInput,
  CreateEmailVerificationInput,
  CreateOAuthAccountInput,
  CreateSessionInput,
  CreateUserInput,
  DesktopAuthCodeRecord,
  EmailVerificationRecord,
  EmailVerificationType,
  OAuthAccountRecord,
  OAuthProviderName,
  SessionRecord,
  UpdateUserInput,
  UpsertAttributionOnceInput,
  UserAttributionRecord,
  UserRecord,
} from "./types";

const AUTH_DOMAIN = "auth" as const;
const logger = loggers.migration();

export const AUTH_SHADOW_OPTIONS: ShadowCompareOptions = {
  redactKeys: ["code", "challenge", "hashedPassword", "email"],
};

export interface DualAuthRepositoryDeps {
  mongo?: MongoAuthRepository;
  pg?: PgAuthRepository;
  router?: MigrationRouter;
  getDb?: () => MakoPgDb;
}

export class DualAuthRepository implements AuthRepository {
  readonly mongo: MongoAuthRepository;
  readonly pg: PgAuthRepository;
  private readonly router: MigrationRouter;
  private readonly getDb: () => MakoPgDb;

  constructor(deps: DualAuthRepositoryDeps = {}) {
    this.mongo = deps.mongo ?? new MongoAuthRepository();
    this.pg = deps.pg ?? new PgAuthRepository({ getDb: deps.getDb });
    this.router = deps.router ?? migrationRouter;
    this.getDb = deps.getDb ?? getPgDb;
  }

  private async getMode() {
    return (await this.router.getState(AUTH_DOMAIN)).mode;
  }

  private async isMongoPrimaryDualWrite(): Promise<boolean> {
    const mode = await this.getMode();
    return (
      mode === "dual_write_mongo_read" || mode === "dual_write_shadow_compare"
    );
  }

  private async isPgSessionMode(): Promise<boolean> {
    const mode = await this.getMode();
    return mode === "dual_write_pg_read" || mode === "pg_only";
  }

  private async recordTombstones(
    tableName: string,
    ids: Iterable<string>,
  ): Promise<void> {
    const db = this.getDb();
    for (const id of ids) {
      if (id) {
        await recordMigrationTombstone(tableName, id, db);
      }
    }
  }

  /**
   * For Stage 4 PG->Mongo secondary writes & shadow reads on child records, map a PG user UUID back
   * to the user's Mongo `_id` (`legacyId` for legacy users, or identical UUIDv7 for new users).
   */
  private async resolveMongoUserIdForReverseSync(
    userId: string,
  ): Promise<string> {
    const pgUser = await this.pg.findUserById(userId);
    return pgUser?.legacyId ?? userId;
  }

  private async resolveMongoUserIdsForReverseSync(
    userIds: readonly string[],
  ): Promise<string[]> {
    if (userIds.length === 0) return [];
    const pgUsers = await this.pg.findUsersByIds(userIds);
    const byId = new Map<string, string>();
    for (const u of pgUsers) {
      const target = u.legacyId ?? u.id;
      byId.set(u.id, target);
      if (u.legacyId) {
        byId.set(u.legacyId, target);
      }
    }
    return userIds.map(id => byId.get(id.toLowerCase()) ?? byId.get(id) ?? id);
  }

  // ── User ID resolution helpers ──────────────────────────────────────────

  async resolveUserUuid(idOrLegacyId: string): Promise<string | null> {
    if (!idOrLegacyId) return null;
    const mode = await this.getMode();
    if (mode === "mongo_only") {
      return this.mongo.resolveUserUuid(idOrLegacyId);
    }
    const fromPg = await this.pg.resolveUserUuid(idOrLegacyId);
    if (fromPg) return fromPg;
    if (mode === "pg_only") return null;
    return this.mongo.resolveUserUuid(idOrLegacyId);
  }

  async getUserLegacyIdMap(): Promise<Map<string, string>> {
    const mode = await this.getMode();
    if (mode === "mongo_only") {
      return this.mongo.getUserLegacyIdMap();
    }
    return this.pg.getUserLegacyIdMap();
  }

  // ── Users ───────────────────────────────────────────────────────────────

  findUserById(idOrLegacyId: string): Promise<UserRecord | null> {
    let pgResult: UserRecord | null | undefined;

    return this.router.executeRead(
      {
        domain: AUTH_DOMAIN,
        operation: "findUserById",
        entityId: idOrLegacyId,
      },
      {
        mongo: () => {
          // In Stage 4 reverse shadow (off critical path), reuse the already-fetched
          // PG row's `legacyId` so zero extra PG queries are ever issued.
          const mongoLookupId = pgResult?.legacyId ?? idOrLegacyId;
          return this.mongo.findUserById(mongoLookupId);
        },
        pg: async () => {
          const row = await this.pg.findUserById(idOrLegacyId);
          pgResult = row;
          return row;
        },
        canonicalize: canonicalizeUserForCompare,
        shadowOptions: AUTH_SHADOW_OPTIONS,
      },
    );
  }

  findUsersByIds(ids: readonly string[]): Promise<UserRecord[]> {
    let pgResults: UserRecord[] | undefined;

    return this.router.executeRead(
      { domain: AUTH_DOMAIN, operation: "findUsersByIds" },
      {
        mongo: () => {
          let mongoLookupIds: readonly string[] = ids;
          if (pgResults !== undefined && pgResults.length > 0) {
            const byId = new Map<string, string>();
            for (const u of pgResults) {
              const target = u.legacyId ?? u.id;
              byId.set(u.id, target);
              if (u.legacyId) {
                byId.set(u.legacyId, target);
              }
            }
            mongoLookupIds = ids.map(
              id => byId.get(id.toLowerCase()) ?? byId.get(id) ?? id,
            );
          }
          return this.mongo.findUsersByIds(mongoLookupIds);
        },
        pg: async () => {
          const rows = await this.pg.findUsersByIds(ids);
          pgResults = rows;
          return rows;
        },
        canonicalize: canonicalizeUsersForCompare,
        shadowOptions: AUTH_SHADOW_OPTIONS,
      },
    );
  }

  findUserByEmail(email: string): Promise<UserRecord | null> {
    return this.router.executeRead(
      { domain: AUTH_DOMAIN, operation: "findUserByEmail" },
      {
        mongo: () => this.mongo.findUserByEmail(email),
        pg: () => this.pg.findUserByEmail(email),
        canonicalize: canonicalizeUserForCompare,
        shadowOptions: AUTH_SHADOW_OPTIONS,
      },
    );
  }

  findUsersByEmails(emails: readonly string[]): Promise<UserRecord[]> {
    return this.router.executeRead(
      { domain: AUTH_DOMAIN, operation: "findUsersByEmails" },
      {
        mongo: () => this.mongo.findUsersByEmails(emails),
        pg: () => this.pg.findUsersByEmails(emails),
        canonicalize: canonicalizeUsersForCompare,
        shadowOptions: AUTH_SHADOW_OPTIONS,
      },
    );
  }

  createUser(input: CreateUserInput): Promise<UserRecord> {
    const now = input.createdAt ?? new Date();
    const id =
      input.id ??
      (input.createdAt
        ? generateUuidv7(input.createdAt.getTime())
        : generateUuidv7());
    const pgId = deriveUserUuidv7(id, now);
    const prepared: CreateUserInput = {
      ...input,
      id,
      legacyId: input.legacyId ?? id,
      email: normalizeEmailKey(input.email),
      createdAt: now,
      updatedAt: input.updatedAt ?? now,
    };

    return this.router.executeWrite(
      {
        domain: AUTH_DOMAIN,
        operation: "createUser",
        entityId: pgId,
        retryPayload: { table: "users", userId: id, pgUserId: pgId },
      },
      {
        mongo: () => this.mongo.createUser(prepared),
        pg: () => this.pg.createUser(prepared),
      },
    );
  }

  async updateUser(
    idOrLegacyId: string,
    patch: UpdateUserInput,
  ): Promise<UserRecord | null> {
    const prepared: UpdateUserInput = {
      ...patch,
      updatedAt: patch.updatedAt ?? new Date(),
    };
    let resolvedLegacyId: string | undefined;
    let mongoResult: UserRecord | null | undefined;
    let pgResult: UserRecord | null | undefined;
    const retryPayload: Record<string, unknown> = {
      table: "users",
      userId: idOrLegacyId,
    };

    return this.router.executeWrite(
      {
        domain: AUTH_DOMAIN,
        operation: "updateUser",
        entityId: idOrLegacyId,
        retryPayload,
      },
      {
        mongo: async () => {
          const updated = await this.mongo.updateUser(
            resolvedLegacyId ?? idOrLegacyId,
            prepared,
          );
          mongoResult = updated;
          if (updated) {
            retryPayload.userId = updated.id;
          } else if (pgResult) {
            // Stage 4 secondary Mongo write missed a row that succeeded in PG:
            // throw so `onSecondaryFailure` queues a reverse sync-retry upsert.
            throw new Error(
              `Mongo secondary updateUser missed row for user ${resolvedLegacyId ?? idOrLegacyId}`,
            );
          }
          return updated;
        },
        pg: async () => {
          const updated = await this.pg.updateUser(idOrLegacyId, prepared, {
            // Stage 2/3 secondary PG write: if Mongo primary updated an existing
            // user that is not in PG yet, throw so `onSecondaryFailure` queues a
            // sync-retry (which re-reads Mongo and upserts with `updated_at` guard),
            // preventing an in-flight backfill from restoring stale credentials.
            requireExisting: Boolean(mongoResult),
          });
          pgResult = updated;
          if (updated?.legacyId) {
            resolvedLegacyId = updated.legacyId;
          }
          return updated;
        },
      },
    );
  }

  // ── User attributions ───────────────────────────────────────────────────

  async upsertAttributionOnce(
    input: UpsertAttributionOnceInput,
  ): Promise<void> {
    const prepared: UpsertAttributionOnceInput = {
      ...input,
      capturedAt: input.capturedAt ?? new Date(),
    };
    const mode = await this.getMode();
    let mongoUserId = prepared.userId;
    if (mode === "dual_write_pg_read") {
      mongoUserId = await this.resolveMongoUserIdForReverseSync(
        prepared.userId,
      );
    }

    return this.router.executeWrite(
      {
        domain: AUTH_DOMAIN,
        operation: "upsertAttributionOnce",
        entityId: prepared.userId,
        retryPayload: {
          table: "user_attributions",
          userId: prepared.userId,
        },
      },
      {
        mongo: () =>
          this.mongo.upsertAttributionOnce({
            ...prepared,
            userId: mongoUserId,
          }),
        pg: () => this.pg.upsertAttributionOnce(prepared),
      },
    );
  }

  findAttributionByUserId(
    userId: string,
  ): Promise<UserAttributionRecord | null> {
    let pgRan = false;

    return this.router.executeRead(
      {
        domain: AUTH_DOMAIN,
        operation: "findAttributionByUserId",
        entityId: userId,
      },
      {
        mongo: async () => {
          const mongoLookupUserId = pgRan
            ? await this.resolveMongoUserIdForReverseSync(userId)
            : userId;
          return this.mongo.findAttributionByUserId(mongoLookupUserId);
        },
        pg: () => {
          pgRan = true;
          return this.pg.findAttributionByUserId(userId);
        },
        canonicalize: rec =>
          rec ? { ...rec, userId: "<matched-user>" } : null,
        shadowOptions: AUTH_SHADOW_OPTIONS,
      },
    );
  }

  // ── OAuth accounts ──────────────────────────────────────────────────────

  findOAuthAccountByProvider(
    provider: OAuthProviderName,
    providerUserId: string,
  ): Promise<OAuthAccountRecord | null> {
    const userUuidMap = new Map<string, string>();
    let mongoRecord: OAuthAccountRecord | null | undefined;
    let pgRan = false;

    return this.router.executeRead(
      {
        domain: AUTH_DOMAIN,
        operation: "findOAuthAccountByProvider",
        entityId: `${provider}:${providerUserId}`,
      },
      {
        mongo: async () => {
          const rec = await this.mongo.findOAuthAccountByProvider(
            provider,
            providerUserId,
          );
          mongoRecord = rec;
          // Stage 4 reverse shadow (off critical path, only when sampled):
          if (pgRan && rec && !isUuidv7(rec.userId)) {
            const mapped = await this.pg
              .resolveUserUuid(rec.userId)
              .catch(() => null);
            if (mapped) {
              userUuidMap.set(rec.userId, mapped);
            }
          }
          return rec;
        },
        pg: async () => {
          pgRan = true;
          const rec = await this.pg.findOAuthAccountByProvider(
            provider,
            providerUserId,
          );
          // Stage 3 forward shadow (off critical path, only when sampled):
          if (mongoRecord && !isUuidv7(mongoRecord.userId)) {
            const mapped = await this.pg
              .resolveUserUuid(mongoRecord.userId)
              .catch(() => null);
            if (mapped) {
              userUuidMap.set(mongoRecord.userId, mapped);
            }
          }
          return rec;
        },
        canonicalize: rec =>
          rec
            ? {
                ...rec,
                userId: userUuidMap.get(rec.userId) ?? rec.userId.toLowerCase(),
              }
            : null,
        shadowOptions: AUTH_SHADOW_OPTIONS,
      },
    );
  }

  findOAuthAccountsByUserId(userId: string): Promise<OAuthAccountRecord[]> {
    let pgRan = false;

    return this.router.executeRead(
      {
        domain: AUTH_DOMAIN,
        operation: "findOAuthAccountsByUserId",
        entityId: userId,
      },
      {
        mongo: async () => {
          const mongoLookupUserId = pgRan
            ? await this.resolveMongoUserIdForReverseSync(userId)
            : userId;
          return this.mongo.findOAuthAccountsByUserId(mongoLookupUserId);
        },
        pg: () => {
          pgRan = true;
          return this.pg.findOAuthAccountsByUserId(userId);
        },
        canonicalize: records =>
          sortRecordsById(records).map(r => ({
            ...r,
            userId: "<matched-user>",
          })),
        shadowOptions: AUTH_SHADOW_OPTIONS,
      },
    );
  }

  findOAuthAccountsByUserIds(
    userIds: readonly string[],
  ): Promise<OAuthAccountRecord[]> {
    const userUuidMap = new Map<string, string>();
    let mongoRecords: OAuthAccountRecord[] | undefined;
    let pgRan = false;

    return this.router.executeRead(
      { domain: AUTH_DOMAIN, operation: "findOAuthAccountsByUserIds" },
      {
        mongo: async () => {
          const mongoLookupUserIds = pgRan
            ? await this.resolveMongoUserIdsForReverseSync(userIds)
            : userIds;
          const recs =
            await this.mongo.findOAuthAccountsByUserIds(mongoLookupUserIds);
          mongoRecords = recs;
          // Stage 4 reverse shadow (off critical path, only when sampled):
          if (pgRan && recs.length > 0) {
            const legacyIds = [
              ...new Set(recs.map(r => r.userId).filter(id => !isUuidv7(id))),
            ];
            if (legacyIds.length > 0) {
              const matchedUsers = await this.pg
                .findUsersByIds(legacyIds)
                .catch(() => []);
              for (const u of matchedUsers) {
                if (u.legacyId) {
                  userUuidMap.set(u.legacyId, u.id);
                }
              }
            }
          }
          return recs;
        },
        pg: async () => {
          pgRan = true;
          const recs = await this.pg.findOAuthAccountsByUserIds(userIds);
          // Stage 3 forward shadow (off critical path, only when sampled):
          if (mongoRecords && mongoRecords.length > 0) {
            const legacyIds = [
              ...new Set(
                mongoRecords.map(r => r.userId).filter(id => !isUuidv7(id)),
              ),
            ];
            if (legacyIds.length > 0) {
              const matchedUsers = await this.pg
                .findUsersByIds(legacyIds)
                .catch(() => []);
              for (const u of matchedUsers) {
                if (u.legacyId) {
                  userUuidMap.set(u.legacyId, u.id);
                }
              }
            }
          }
          return recs;
        },
        canonicalize: records =>
          sortRecordsById(records).map(r => ({
            ...r,
            userId: userUuidMap.get(r.userId) ?? r.userId.toLowerCase(),
          })),
        shadowOptions: AUTH_SHADOW_OPTIONS,
      },
    );
  }

  async createOAuthAccount(
    input: CreateOAuthAccountInput,
  ): Promise<OAuthAccountRecord> {
    const createdAt = input.createdAt ?? new Date();
    const id = input.id ?? newDualId(createdAt.getTime()).oid;
    const prepared: CreateOAuthAccountInput = {
      ...input,
      id,
      createdAt,
    };
    const mode = await this.getMode();
    let mongoUserId = prepared.userId;
    if (mode === "dual_write_pg_read") {
      mongoUserId = await this.resolveMongoUserIdForReverseSync(
        prepared.userId,
      );
    }

    return this.router.executeWrite(
      {
        domain: AUTH_DOMAIN,
        operation: "createOAuthAccount",
        entityId: id,
        retryPayload: {
          table: "oauth_accounts",
          oauthAccountId: id,
          provider: prepared.provider,
          providerUserId: prepared.providerUserId,
        },
      },
      {
        mongo: () =>
          this.mongo.createOAuthAccount({ ...prepared, userId: mongoUserId }),
        pg: () => this.pg.createOAuthAccount(prepared),
      },
    );
  }

  // ── Sessions (Decision #3: NEVER backfilled or dual-written!) ───────────
  // Stages 1–3 use Mongo exclusively; Stages 4–5 use PG hashed-token sessions exclusively.

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    return (await this.isPgSessionMode())
      ? this.pg.createSession(input)
      : this.mongo.createSession(input);
  }

  async findSessionById(sessionId: string): Promise<SessionRecord | null> {
    return (await this.isPgSessionMode())
      ? this.pg.findSessionById(sessionId)
      : this.mongo.findSessionById(sessionId);
  }

  async updateSessionExpiry(sessionId: string, expiresAt: Date): Promise<void> {
    return (await this.isPgSessionMode())
      ? this.pg.updateSessionExpiry(sessionId, expiresAt)
      : this.mongo.updateSessionExpiry(sessionId, expiresAt);
  }

  async updateSessionActiveWorkspace(
    sessionId: string,
    activeWorkspaceId: string | null,
  ): Promise<void> {
    return (await this.isPgSessionMode())
      ? this.pg.updateSessionActiveWorkspace(sessionId, activeWorkspaceId)
      : this.mongo.updateSessionActiveWorkspace(sessionId, activeWorkspaceId);
  }

  async setActiveWorkspaceForUser(
    userId: string,
    activeWorkspaceId: string | null,
  ): Promise<void> {
    return (await this.isPgSessionMode())
      ? this.pg.setActiveWorkspaceForUser(userId, activeWorkspaceId)
      : this.mongo.setActiveWorkspaceForUser(userId, activeWorkspaceId);
  }

  async deleteSession(sessionId: string): Promise<void> {
    const mode = await this.getMode();
    if (mode === "pg_only") {
      return this.pg.deleteSession(sessionId);
    }
    if (mode === "dual_write_pg_read") {
      await this.pg.deleteSession(sessionId);
      // Best-effort revoke matching Mongo session so a Stage 4 -> Stage 3/2
      // rollback never resurrects a logged-out or revoked session cookie.
      // Raw session tokens are never logged or enqueued to Inngest.
      try {
        await this.mongo.deleteSession(sessionId);
      } catch (error) {
        logger.warn("Best-effort Mongo session delete failed in Stage 4", {
          operation: "deleteSession",
          error: error instanceof Error ? error.message : String(error),
        });
      }
      return;
    }
    return this.mongo.deleteSession(sessionId);
  }

  async deleteUserSessions(userId: string): Promise<void> {
    const mode = await this.getMode();
    if (mode === "pg_only") {
      return this.pg.deleteUserSessions(userId);
    }
    if (mode === "dual_write_pg_read") {
      // Resolve both the PG UUID and legacy Mongo `_id` so pre-cutover Stage 3
      // Mongo sessions keyed by `legacyId` are also revoked (e.g. password reset)
      // and cannot be resurrected on Stage 4 -> Stage 3/2 rollback.
      const pgUser = await this.pg.findUserById(userId).catch(() => null);
      await this.pg.deleteUserSessions(userId);
      const mongoUserIds = new Set<string>([userId]);
      if (pgUser?.id) mongoUserIds.add(pgUser.id);
      if (pgUser?.legacyId) mongoUserIds.add(pgUser.legacyId);
      try {
        for (const candidateUserId of mongoUserIds) {
          await this.mongo.deleteUserSessions(candidateUserId);
        }
      } catch (error) {
        logger.warn(
          "Best-effort Mongo user sessions delete failed in Stage 4",
          {
            operation: "deleteUserSessions",
            userId,
            error: error instanceof Error ? error.message : String(error),
          },
        );
      }
      return;
    }
    return this.mongo.deleteUserSessions(userId);
  }

  async deleteExpiredSessions(now: Date = new Date()): Promise<number> {
    return (await this.isPgSessionMode())
      ? this.pg.deleteExpiredSessions(now)
      : this.mongo.deleteExpiredSessions(now);
  }

  // ── Email verifications ─────────────────────────────────────────────────

  createEmailVerification(
    input: CreateEmailVerificationInput,
  ): Promise<EmailVerificationRecord> {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? new Date();
    const prepared: CreateEmailVerificationInput = {
      ...input,
      id,
      email: normalizeEmailKey(input.email),
      createdAt,
    };

    return this.router.executeWrite(
      {
        domain: AUTH_DOMAIN,
        operation: "createEmailVerification",
        entityId: id,
        retryPayload: { table: "email_verifications", verificationId: id },
      },
      {
        mongo: () => this.mongo.createEmailVerification(prepared),
        pg: () => this.pg.createEmailVerification(prepared),
      },
    );
  }

  findValidEmailVerification(
    email: string,
    code: string,
    type: EmailVerificationType,
    now: Date = new Date(),
  ): Promise<EmailVerificationRecord | null> {
    return this.router.executeRead(
      { domain: AUTH_DOMAIN, operation: "findValidEmailVerification" },
      {
        mongo: () =>
          this.mongo.findValidEmailVerification(email, code, type, now),
        pg: () => this.pg.findValidEmailVerification(email, code, type, now),
        shadowOptions: AUTH_SHADOW_OPTIONS,
      },
    );
  }

  async deleteEmailVerificationById(id: string): Promise<void> {
    const tombstone = await this.isMongoPrimaryDualWrite();
    return this.router.executeWrite(
      {
        domain: AUTH_DOMAIN,
        operation: "deleteEmailVerificationById",
        entityId: id,
        retryPayload: { table: "email_verifications", verificationId: id },
      },
      {
        mongo: () => this.mongo.deleteEmailVerificationById(id),
        pg: async () => {
          await this.pg.deleteEmailVerificationById(id);
          if (tombstone) {
            await this.recordTombstones("email_verifications", [id]);
          }
        },
      },
    );
  }

  async deleteEmailVerificationsByEmailAndType(
    email: string,
    type: EmailVerificationType,
  ): Promise<void> {
    const normalizedEmail = normalizeEmailKey(email);
    const tombstone = await this.isMongoPrimaryDualWrite();
    let mongoRan = false;
    let pgRan = false;
    const mongoDeletedIds = new Set<string>();
    const pgDeletedIds = new Set<string>();
    // Mutated with ONLY the exact verification IDs deleted by the primary store
    // (never user email PII) so delayed secondary replays delete only those IDs
    // and never wipe verification codes created after the original delete.
    const retryPayload: Record<string, unknown> = {
      table: "email_verifications",
      verificationIds: [] as string[],
    };

    return this.router.executeWrite(
      {
        domain: AUTH_DOMAIN,
        operation: "deleteEmailVerificationsByEmailAndType",
        retryPayload,
      },
      {
        mongo: async () => {
          mongoRan = true;
          if (pgRan) {
            await this.mongo.deleteEmailVerificationsByIds([...pgDeletedIds]);
            return;
          }
          const mongoIds =
            await this.mongo.deleteEmailVerificationsReturningIds(
              normalizedEmail,
              type,
            );
          for (const id of mongoIds) {
            mongoDeletedIds.add(id);
          }
          retryPayload.verificationIds = [...mongoDeletedIds];
        },
        pg: async () => {
          pgRan = true;
          const pgIds = await this.pg.deleteEmailVerificationsReturningIds(
            normalizedEmail,
            type,
          );
          for (const id of pgIds) {
            pgDeletedIds.add(id);
          }
          if (!mongoRan) {
            retryPayload.verificationIds = [...pgDeletedIds];
          }
          if (tombstone) {
            // Tombstone the union of Mongo-deleted and PG-deleted IDs so an
            // in-flight backfill cannot resurrect codes that existed only in
            // Mongo at the moment of deletion.
            const allDeletedIds = new Set<string>([
              ...mongoDeletedIds,
              ...pgDeletedIds,
            ]);
            await this.recordTombstones("email_verifications", allDeletedIds);
          }
        },
      },
    );
  }

  // ── Desktop auth codes ──────────────────────────────────────────────────

  async createDesktopAuthCode(
    input: CreateDesktopAuthCodeInput,
  ): Promise<DesktopAuthCodeRecord> {
    const createdAt = input.createdAt ?? new Date();
    const prepared: CreateDesktopAuthCodeInput = {
      ...input,
      createdAt,
    };
    const mode = await this.getMode();
    let mongoUserId = prepared.userId;
    if (mode === "dual_write_pg_read") {
      mongoUserId = await this.resolveMongoUserIdForReverseSync(
        prepared.userId,
      );
    }

    return this.router.executeWrite(
      {
        domain: AUTH_DOMAIN,
        operation: "createDesktopAuthCode",
        entityId: prepared.id,
        retryPayload: {
          table: "desktop_auth_codes",
          codeHash: prepared.id,
        },
      },
      {
        mongo: () =>
          this.mongo.createDesktopAuthCode({
            ...prepared,
            userId: mongoUserId,
          }),
        pg: () => this.pg.createDesktopAuthCode(prepared),
      },
    );
  }

  async redeemAndDeleteDesktopAuthCode(
    codeHash: string,
  ): Promise<DesktopAuthCodeRecord | null> {
    const tombstone = await this.isMongoPrimaryDualWrite();
    let primaryMatched = false;

    return this.router.executeWrite(
      {
        domain: AUTH_DOMAIN,
        operation: "redeemAndDeleteDesktopAuthCode",
        entityId: codeHash,
        retryPayload: { table: "desktop_auth_codes", codeHash },
      },
      {
        mongo: async () => {
          const doc = await this.mongo.redeemAndDeleteDesktopAuthCode(codeHash);
          if (doc) primaryMatched = true;
          return doc;
        },
        pg: async () => {
          const row = await this.pg.redeemAndDeleteDesktopAuthCode(codeHash);
          if (tombstone && (primaryMatched || row)) {
            await this.recordTombstones("desktop_auth_codes", [codeHash]);
          }
          return row;
        },
      },
    );
  }
}

/**
 * Postgres (Neon / Drizzle) implementation of `AuthRepository` (Decision #3).
 *
 * Key invariants:
 *   - `users.id` is RFC 9562 UUIDv7; `users.legacy_id` stores the original Mongo `_id`
 *     (15-char Lucia ID, old UUIDv4, or matching UUIDv7) so callers holding either ID
 *     resolve seamlessly without invalid-UUID errors.
 *   - `sessions.token_hash` stores ONLY `sha256Hex(rawToken)`; the raw session token
 *     never enters Postgres. `findSessionById` enforces `expires_at > now()`.
 */
import { randomUUID } from "node:crypto";
import { and, eq, gt, inArray, isNotNull, lte, ne, or, sql } from "drizzle-orm";
import { extractRows, getPgDb, type MakoPgDb } from "../../database/pg/client";
import {
  generateUuidv7,
  isUuidString,
  newDualId,
} from "../../database/pg/id-codec";
import {
  desktopAuthCodes,
  emailVerifications,
  oauthAccounts,
  sessions,
  userAttributions,
  users,
} from "../../database/pg/schema/auth";
import {
  attributionRecordToPgInsert,
  deriveUserUuidv7,
  desktopAuthCodeRecordToPgInsert,
  emailVerificationRecordToPgInsert,
  hashSessionToken,
  normalizeEmailKey,
  normalizeOnboarding,
  oauthAccountRecordToPgInsert,
  oauthIdToPgUuid,
  pgAttributionToRecord,
  pgDesktopAuthCodeToRecord,
  pgEmailVerificationToRecord,
  pgOAuthAccountToRecord,
  pgSessionToRecord,
  pgUserToRecord,
  sanitizeTouchPayload,
  sessionWorkspaceIdToPgUuid,
  userRecordToPgInsert,
} from "./mapper";
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

export class PgAuthRepository implements AuthRepository {
  private readonly getDb: () => MakoPgDb;

  constructor(options: { getDb?: () => MakoPgDb } = {}) {
    this.getDb = options.getDb ?? getPgDb;
  }

  // ── User ID resolution ──────────────────────────────────────────────────

  async resolveUserUuid(
    idOrLegacyId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<string | null> {
    if (!idOrLegacyId) return null;
    const whereClause = isUuidString(idOrLegacyId)
      ? or(
          eq(users.id, idOrLegacyId.toLowerCase()),
          eq(users.legacyId, idOrLegacyId),
        )
      : eq(users.legacyId, idOrLegacyId);
    const rows = await db
      .select({ id: users.id })
      .from(users)
      .where(whereClause)
      .limit(1);
    return rows[0] ? rows[0].id.toLowerCase() : null;
  }

  async getUserLegacyIdMap(
    db: MakoPgDb = this.getDb(),
  ): Promise<Map<string, string>> {
    const rows = await db
      .select({ legacyId: users.legacyId, id: users.id })
      .from(users)
      .where(
        and(
          isNotNull(users.legacyId),
          ne(users.legacyId, sql`${users.id}::text`),
        ),
      );
    const map = new Map<string, string>();
    for (const row of rows) {
      if (row.legacyId) {
        map.set(row.legacyId, row.id.toLowerCase());
      }
    }
    return map;
  }

  private async resolveWriteUserUuid(
    userId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<string> {
    const resolved = await this.resolveUserUuid(userId, db);
    if (resolved) return resolved;
    if (isUuidString(userId)) {
      return userId.toLowerCase();
    }
    throw new Error(
      `Cannot resolve legacy userId ${JSON.stringify(userId)} to a Postgres user UUID`,
    );
  }

  // ── Users ───────────────────────────────────────────────────────────────

  async findUserById(
    idOrLegacyId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<UserRecord | null> {
    if (!idOrLegacyId) return null;
    const whereClause = isUuidString(idOrLegacyId)
      ? or(
          eq(users.id, idOrLegacyId.toLowerCase()),
          eq(users.legacyId, idOrLegacyId),
        )
      : eq(users.legacyId, idOrLegacyId);
    const rows = await db.select().from(users).where(whereClause).limit(1);
    return rows[0] ? pgUserToRecord(rows[0]) : null;
  }

  async findUsersByIds(ids: readonly string[]): Promise<UserRecord[]> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return [];
    const uuidCandidates = unique
      .filter(isUuidString)
      .map(id => id.toLowerCase());
    const whereClause =
      uuidCandidates.length > 0
        ? or(inArray(users.id, uuidCandidates), inArray(users.legacyId, unique))
        : inArray(users.legacyId, unique);
    const rows = await this.getDb().select().from(users).where(whereClause);
    return rows.map(pgUserToRecord);
  }

  async findUserByEmail(email: string): Promise<UserRecord | null> {
    const normalized = normalizeEmailKey(email);
    if (!normalized) return null;
    const rows = await this.getDb()
      .select()
      .from(users)
      .where(eq(users.email, normalized))
      .limit(1);
    return rows[0] ? pgUserToRecord(rows[0]) : null;
  }

  async findUsersByEmails(emails: readonly string[]): Promise<UserRecord[]> {
    const unique = [...new Set(emails.map(normalizeEmailKey).filter(Boolean))];
    if (unique.length === 0) return [];
    const rows = await this.getDb()
      .select()
      .from(users)
      .where(inArray(users.email, unique));
    return rows.map(pgUserToRecord);
  }

  async createUser(input: CreateUserInput): Promise<UserRecord> {
    const now = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? now;
    const pgId = input.id
      ? deriveUserUuidv7(input.id, now)
      : input.createdAt
        ? generateUuidv7(input.createdAt.getTime())
        : generateUuidv7();
    const legacyId = input.legacyId ?? input.id ?? pgId;
    const onboarding = normalizeOnboarding(input.onboarding);

    const rows = await this.getDb()
      .insert(users)
      .values({
        id: pgId,
        legacyId,
        email: normalizeEmailKey(input.email),
        name: input.name ?? null,
        hashedPassword: input.hashedPassword ?? null,
        emailVerified: input.emailVerified ?? false,
        onboardingCompletedAt: onboarding?.completedAt ?? null,
        onboardingCompanySize: onboarding?.companySize ?? null,
        onboardingRole: onboarding?.role ?? null,
        onboardingPrimaryDatabase: onboarding?.primaryDatabase ?? null,
        onboardingDataWarehouse: onboarding?.dataWarehouse ?? null,
        createdAt: now,
        updatedAt,
      })
      .returning();

    return pgUserToRecord(rows[0]);
  }

  async updateUser(
    idOrLegacyId: string,
    patch: UpdateUserInput,
    options?: { requireExisting?: boolean },
  ): Promise<UserRecord | null> {
    const pgUuid = await this.resolveUserUuid(idOrLegacyId);
    if (!pgUuid) {
      if (options?.requireExisting) {
        throw new Error(
          `Postgres user row not found for updateUser(${JSON.stringify(idOrLegacyId)})`,
        );
      }
      return null;
    }

    const values: Partial<typeof users.$inferInsert> = {
      updatedAt: patch.updatedAt ?? new Date(),
    };

    if (patch.emailVerified !== undefined) {
      values.emailVerified = patch.emailVerified;
    }
    if (patch.name !== undefined) {
      values.name = patch.name;
    }
    if (patch.hashedPassword !== undefined) {
      values.hashedPassword = patch.hashedPassword;
    }
    if (patch.onboarding !== undefined) {
      if (patch.onboarding.completedAt !== undefined) {
        values.onboardingCompletedAt = patch.onboarding.completedAt;
      }
      if (patch.onboarding.companySize !== undefined) {
        values.onboardingCompanySize = patch.onboarding.companySize;
      }
      if (patch.onboarding.role !== undefined) {
        values.onboardingRole = patch.onboarding.role;
      }
      if (patch.onboarding.primaryDatabase !== undefined) {
        values.onboardingPrimaryDatabase = patch.onboarding.primaryDatabase;
      }
      if (patch.onboarding.dataWarehouse !== undefined) {
        values.onboardingDataWarehouse = patch.onboarding.dataWarehouse;
      }
    }

    const rows = await this.getDb()
      .update(users)
      .set(values)
      .where(eq(users.id, pgUuid))
      .returning();

    if (!rows[0]) {
      if (options?.requireExisting) {
        throw new Error(
          `Postgres user row vanished during updateUser(${JSON.stringify(idOrLegacyId)})`,
        );
      }
      return null;
    }
    return pgUserToRecord(rows[0]);
  }

  /**
   * Idempotent backfill/sync-retry upsert with `updated_at` stale-write guard:
   * never overwrites a newer live dual-write row. Returns `true` if a row was
   * inserted or updated.
   */
  async upsertUserWithGuard(
    record: UserRecord,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const row = userRecordToPgInsert(record);
    const res = await db.execute(sql`
      INSERT INTO "users" (
        "id",
        "legacy_id",
        "email",
        "name",
        "hashed_password",
        "email_verified",
        "onboarding_completed_at",
        "onboarding_company_size",
        "onboarding_role",
        "onboarding_primary_database",
        "onboarding_data_warehouse",
        "created_at",
        "updated_at"
      )
      VALUES (
        ${row.id}::uuid,
        ${row.legacyId ?? null},
        ${row.email},
        ${row.name ?? null},
        ${row.hashedPassword ?? null},
        ${row.emailVerified ?? false},
        ${row.onboardingCompletedAt ? row.onboardingCompletedAt.toISOString() : null}::timestamptz,
        ${row.onboardingCompanySize ?? null},
        ${row.onboardingRole ?? null},
        ${row.onboardingPrimaryDatabase ?? null},
        ${row.onboardingDataWarehouse ?? null},
        ${(row.createdAt ?? new Date()).toISOString()}::timestamptz,
        ${(row.updatedAt ?? new Date()).toISOString()}::timestamptz
      )
      ON CONFLICT ("id") DO UPDATE SET
        "legacy_id" = COALESCE("users"."legacy_id", EXCLUDED."legacy_id"),
        "email" = EXCLUDED."email",
        "name" = EXCLUDED."name",
        "hashed_password" = EXCLUDED."hashed_password",
        "email_verified" = EXCLUDED."email_verified",
        "onboarding_completed_at" = EXCLUDED."onboarding_completed_at",
        "onboarding_company_size" = EXCLUDED."onboarding_company_size",
        "onboarding_role" = EXCLUDED."onboarding_role",
        "onboarding_primary_database" = EXCLUDED."onboarding_primary_database",
        "onboarding_data_warehouse" = EXCLUDED."onboarding_data_warehouse",
        "updated_at" = EXCLUDED."updated_at"
      WHERE "users"."updated_at" IS NULL
         OR EXCLUDED."updated_at" >= "users"."updated_at"
      RETURNING "id"
    `);
    return extractRows(res).length > 0;
  }

  // ── User attributions ───────────────────────────────────────────────────

  async upsertAttributionOnce(
    input: UpsertAttributionOnceInput,
    db: MakoPgDb = this.getDb(),
  ): Promise<void> {
    const pgUserUuid = await this.resolveWriteUserUuid(input.userId, db);
    await db
      .insert(userAttributions)
      .values({
        userId: pgUserUuid,
        sid: input.sid ?? null,
        gclid: input.gclid ?? null,
        signupMethod: input.signupMethod,
        country: input.country ?? null,
        firstTouch: sanitizeTouchPayload(input.firstTouch),
        lastTouch: sanitizeTouchPayload(input.lastTouch),
        capturedAt: input.capturedAt ?? new Date(),
      })
      .onConflictDoNothing({ target: userAttributions.userId });
  }

  async upsertAttributionIgnoreConflict(
    record: UserAttributionRecord,
    pgUserUuid: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const rows = await db
      .insert(userAttributions)
      .values(attributionRecordToPgInsert(record, pgUserUuid))
      .onConflictDoNothing({ target: userAttributions.userId })
      .returning({ userId: userAttributions.userId });
    return rows.length > 0;
  }

  async findAttributionByUserId(
    userId: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<UserAttributionRecord | null> {
    const pgUserUuid = await this.resolveUserUuid(userId, db);
    if (!pgUserUuid) return null;
    const rows = await db
      .select()
      .from(userAttributions)
      .where(eq(userAttributions.userId, pgUserUuid))
      .limit(1);
    return rows[0] ? pgAttributionToRecord(rows[0]) : null;
  }

  // ── OAuth accounts ──────────────────────────────────────────────────────

  async findOAuthAccountByProvider(
    provider: OAuthProviderName,
    providerUserId: string,
  ): Promise<OAuthAccountRecord | null> {
    const rows = await this.getDb()
      .select()
      .from(oauthAccounts)
      .where(
        and(
          eq(oauthAccounts.provider, provider),
          eq(oauthAccounts.providerUserId, providerUserId),
        ),
      )
      .limit(1);
    return rows[0] ? pgOAuthAccountToRecord(rows[0]) : null;
  }

  async findOAuthAccountById(
    id: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<OAuthAccountRecord | null> {
    const uuid = oauthIdToPgUuid(id);
    const rows = await db
      .select()
      .from(oauthAccounts)
      .where(eq(oauthAccounts.id, uuid))
      .limit(1);
    return rows[0] ? pgOAuthAccountToRecord(rows[0]) : null;
  }

  async findOAuthAccountsByUserId(
    userId: string,
  ): Promise<OAuthAccountRecord[]> {
    const pgUserUuid = await this.resolveUserUuid(userId);
    if (!pgUserUuid) return [];
    const rows = await this.getDb()
      .select()
      .from(oauthAccounts)
      .where(eq(oauthAccounts.userId, pgUserUuid));
    return rows.map(pgOAuthAccountToRecord);
  }

  async findOAuthAccountsByUserIds(
    userIds: readonly string[],
  ): Promise<OAuthAccountRecord[]> {
    const unique = [...new Set(userIds.filter(Boolean))];
    if (unique.length === 0) return [];
    const matchedUsers = await this.findUsersByIds(unique);
    const resolvedUuids = [...new Set(matchedUsers.map(u => u.id))];
    if (resolvedUuids.length === 0) return [];
    const rows = await this.getDb()
      .select()
      .from(oauthAccounts)
      .where(inArray(oauthAccounts.userId, resolvedUuids));
    return rows.map(pgOAuthAccountToRecord);
  }

  async createOAuthAccount(
    input: CreateOAuthAccountInput,
  ): Promise<OAuthAccountRecord> {
    const createdAt = input.createdAt ?? new Date();
    const pgId = input.id
      ? oauthIdToPgUuid(input.id)
      : newDualId(createdAt.getTime()).uuid;
    const pgUserUuid = await this.resolveWriteUserUuid(input.userId);

    const rows = await this.getDb()
      .insert(oauthAccounts)
      .values({
        id: pgId,
        userId: pgUserUuid,
        provider: input.provider,
        providerUserId: input.providerUserId,
        email: input.email ?? null,
        createdAt,
      })
      .returning();

    return pgOAuthAccountToRecord(rows[0]);
  }

  async upsertOAuthAccountIdempotent(
    record: OAuthAccountRecord,
    pgUserUuid: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const row = oauthAccountRecordToPgInsert(record, pgUserUuid);
    const existingByProvider = await db
      .select({ id: oauthAccounts.id })
      .from(oauthAccounts)
      .where(
        and(
          eq(oauthAccounts.provider, row.provider),
          eq(oauthAccounts.providerUserId, row.providerUserId),
        ),
      )
      .limit(1);
    if (existingByProvider[0] && existingByProvider[0].id !== row.id) {
      const updated = await db
        .update(oauthAccounts)
        .set({
          userId: row.userId,
          email: row.email ?? null,
        })
        .where(eq(oauthAccounts.id, existingByProvider[0].id))
        .returning({ id: oauthAccounts.id });
      return updated.length > 0;
    }

    const rows = await db
      .insert(oauthAccounts)
      .values(row)
      .onConflictDoUpdate({
        target: oauthAccounts.id,
        set: {
          userId: row.userId,
          provider: row.provider,
          providerUserId: row.providerUserId,
          email: row.email ?? null,
        },
      })
      .returning({ id: oauthAccounts.id });
    return rows.length > 0;
  }

  // ── Sessions (hashed-token PK; starts EMPTY in Postgres) ────────────────

  async createSession(input: CreateSessionInput): Promise<SessionRecord> {
    const pgUserUuid = await this.resolveWriteUserUuid(input.userId);
    const tokenHash = hashSessionToken(input.id);
    const now = new Date();

    const rows = await this.getDb()
      .insert(sessions)
      .values({
        tokenHash,
        userId: pgUserUuid,
        expiresAt: input.expiresAt,
        activeWorkspaceId: sessionWorkspaceIdToPgUuid(input.activeWorkspaceId),
        createdAt: now,
        updatedAt: now,
      })
      .returning();
    return pgSessionToRecord(rows[0], input.id);
  }

  async findSessionById(
    rawToken: string,
    now: Date = new Date(),
  ): Promise<SessionRecord | null> {
    if (!rawToken) return null;
    const tokenHash = hashSessionToken(rawToken);
    const rows = await this.getDb()
      .select()
      .from(sessions)
      .where(
        and(eq(sessions.tokenHash, tokenHash), gt(sessions.expiresAt, now)),
      )
      .limit(1);
    return rows[0] ? pgSessionToRecord(rows[0], rawToken) : null;
  }

  async updateSessionExpiry(rawToken: string, expiresAt: Date): Promise<void> {
    if (!rawToken) return;
    await this.getDb()
      .update(sessions)
      .set({ expiresAt, updatedAt: new Date() })
      .where(eq(sessions.tokenHash, hashSessionToken(rawToken)));
  }

  async updateSessionActiveWorkspace(
    rawToken: string,
    activeWorkspaceId: string | null,
  ): Promise<void> {
    if (!rawToken) return;
    await this.getDb()
      .update(sessions)
      .set({
        activeWorkspaceId: sessionWorkspaceIdToPgUuid(activeWorkspaceId),
        updatedAt: new Date(),
      })
      .where(eq(sessions.tokenHash, hashSessionToken(rawToken)));
  }

  async setActiveWorkspaceForUser(
    userId: string,
    activeWorkspaceId: string | null,
  ): Promise<void> {
    const pgUserUuid = await this.resolveUserUuid(userId);
    if (!pgUserUuid) return;
    await this.getDb()
      .update(sessions)
      .set({
        activeWorkspaceId: sessionWorkspaceIdToPgUuid(activeWorkspaceId),
        updatedAt: new Date(),
      })
      .where(eq(sessions.userId, pgUserUuid));
  }

  async deleteSession(rawToken: string): Promise<void> {
    if (!rawToken) return;
    await this.getDb()
      .delete(sessions)
      .where(eq(sessions.tokenHash, hashSessionToken(rawToken)));
  }

  async deleteUserSessions(userId: string): Promise<void> {
    const pgUserUuid = await this.resolveUserUuid(userId);
    if (!pgUserUuid) return;
    await this.getDb().delete(sessions).where(eq(sessions.userId, pgUserUuid));
  }

  async deleteExpiredSessions(now: Date = new Date()): Promise<number> {
    const rows = await this.getDb()
      .delete(sessions)
      .where(lte(sessions.expiresAt, now))
      .returning({ tokenHash: sessions.tokenHash });
    return rows.length;
  }

  // ── Email verifications ─────────────────────────────────────────────────

  async createEmailVerification(
    input: CreateEmailVerificationInput,
  ): Promise<EmailVerificationRecord> {
    const id = input.id ?? randomUUID();
    const createdAt = input.createdAt ?? new Date();
    const rows = await this.getDb()
      .insert(emailVerifications)
      .values({
        id,
        email: normalizeEmailKey(input.email),
        code: input.code,
        type: input.type,
        expiresAt: input.expiresAt,
        createdAt,
      })
      .returning();
    return pgEmailVerificationToRecord(rows[0]);
  }

  async findValidEmailVerification(
    email: string,
    code: string,
    type: EmailVerificationType,
    now: Date = new Date(),
  ): Promise<EmailVerificationRecord | null> {
    const rows = await this.getDb()
      .select()
      .from(emailVerifications)
      .where(
        and(
          eq(emailVerifications.email, normalizeEmailKey(email)),
          eq(emailVerifications.code, code),
          eq(emailVerifications.type, type),
          gt(emailVerifications.expiresAt, now),
        ),
      )
      .limit(1);
    return rows[0] ? pgEmailVerificationToRecord(rows[0]) : null;
  }

  async findEmailVerificationById(
    id: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<EmailVerificationRecord | null> {
    const rows = await db
      .select()
      .from(emailVerifications)
      .where(eq(emailVerifications.id, id))
      .limit(1);
    return rows[0] ? pgEmailVerificationToRecord(rows[0]) : null;
  }

  async deleteEmailVerificationById(id: string): Promise<void> {
    await this.getDb()
      .delete(emailVerifications)
      .where(eq(emailVerifications.id, id));
  }

  async deleteEmailVerificationsByIds(ids: readonly string[]): Promise<void> {
    const unique = [...new Set(ids.filter(Boolean))];
    if (unique.length === 0) return;
    await this.getDb()
      .delete(emailVerifications)
      .where(inArray(emailVerifications.id, unique));
  }

  async deleteEmailVerificationsByEmailAndType(
    email: string,
    type: EmailVerificationType,
  ): Promise<void> {
    await this.getDb()
      .delete(emailVerifications)
      .where(
        and(
          eq(emailVerifications.email, normalizeEmailKey(email)),
          eq(emailVerifications.type, type),
        ),
      );
  }

  async deleteEmailVerificationsReturningIds(
    email: string,
    type: EmailVerificationType,
  ): Promise<string[]> {
    const rows = await this.getDb()
      .delete(emailVerifications)
      .where(
        and(
          eq(emailVerifications.email, normalizeEmailKey(email)),
          eq(emailVerifications.type, type),
        ),
      )
      .returning({ id: emailVerifications.id });
    return rows.map(r => r.id);
  }

  async upsertEmailVerificationIdempotent(
    record: EmailVerificationRecord,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const row = emailVerificationRecordToPgInsert(record);
    const rows = await db
      .insert(emailVerifications)
      .values(row)
      .onConflictDoUpdate({
        target: emailVerifications.id,
        set: {
          email: row.email,
          code: row.code,
          type: row.type,
          expiresAt: row.expiresAt,
        },
      })
      .returning({ id: emailVerifications.id });
    return rows.length > 0;
  }

  // ── Desktop auth codes ──────────────────────────────────────────────────

  async createDesktopAuthCode(
    input: CreateDesktopAuthCodeInput,
  ): Promise<DesktopAuthCodeRecord> {
    const createdAt = input.createdAt ?? new Date();
    const pgUserUuid = await this.resolveWriteUserUuid(input.userId);
    const rows = await this.getDb()
      .insert(desktopAuthCodes)
      .values({
        id: input.id,
        userId: pgUserUuid,
        challenge: input.challenge,
        expiresAt: input.expiresAt,
        createdAt,
      })
      .returning();
    return pgDesktopAuthCodeToRecord(rows[0]);
  }

  async findDesktopAuthCodeById(
    codeHash: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<DesktopAuthCodeRecord | null> {
    const rows = await db
      .select()
      .from(desktopAuthCodes)
      .where(eq(desktopAuthCodes.id, codeHash))
      .limit(1);
    return rows[0] ? pgDesktopAuthCodeToRecord(rows[0]) : null;
  }

  async redeemAndDeleteDesktopAuthCode(
    codeHash: string,
  ): Promise<DesktopAuthCodeRecord | null> {
    const rows = await this.getDb()
      .delete(desktopAuthCodes)
      .where(eq(desktopAuthCodes.id, codeHash))
      .returning();
    return rows[0] ? pgDesktopAuthCodeToRecord(rows[0]) : null;
  }

  async upsertDesktopAuthCodeIdempotent(
    record: DesktopAuthCodeRecord,
    pgUserUuid: string,
    db: MakoPgDb = this.getDb(),
  ): Promise<boolean> {
    const row = desktopAuthCodeRecordToPgInsert(record, pgUserUuid);
    const rows = await db
      .insert(desktopAuthCodes)
      .values(row)
      .onConflictDoUpdate({
        target: desktopAuthCodes.id,
        set: {
          userId: row.userId,
          challenge: row.challenge,
          expiresAt: row.expiresAt,
        },
      })
      .returning({ id: desktopAuthCodes.id });
    return rows.length > 0;
  }
}

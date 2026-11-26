/**
 * Phase 1A (`auth` domain — Decision #3) repository contract, 5-stage dual-run,
 * empty-start hashed-token sessions, UUIDv7 user ID mapping, FK-ordered backfill,
 * parity verifier (`--repair`), sync-retry, and TTL reaper test suite.
 */
import { createHash, randomBytes, randomUUID } from "node:crypto";
import type { PGlite } from "@electric-sql/pglite";
import { eq } from "drizzle-orm";
import { drizzle } from "drizzle-orm/pglite";
import mongoose from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import {
  afterAll,
  afterEach,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
} from "vitest";
import { isPersonActorId } from "../../apps/actor-id";
import { authorForUser } from "../../apps/workspace-consoles/authors";
import {
  resetPgTestDb,
  setPgTestDb,
  type MakoPgDb,
} from "../../database/pg/client";
import {
  generateUuidv7,
  isUuidv7,
  legacyUserIdToUuidv7,
  newDualId,
  objectIdToUuid,
  toWireId,
} from "../../database/pg/id-codec";
import { runPgliteMigrations } from "../../database/pg/migrate";
import * as pgSchema from "../../database/pg/schema";
import { createTestPglite } from "../../database/pg/test-pglite";
import {
  DesktopAuthCode,
  EmailVerification,
  OAuthAccount,
  Session,
  User,
  UserAttribution,
} from "../../database/schema";
import {
  clearBackfillRegistryForTests,
  listBackfillDomains,
  runBackfill,
} from "../../migration/backfill";
import { registerMigrationDomains } from "../../migration/domains";
import {
  replayAuthWriteToMongo,
  replayAuthWriteToPg,
} from "../../migration/domains/auth.backfill";
import {
  MigrationRouter,
  recordMigrationTombstone,
} from "../../migration/router";
import {
  ShadowCompareRunner,
  type ShadowCompareEvent,
} from "../../migration/shadow-compare";
import {
  clearTtlRegistryForTests,
  listTtlRules,
  reapAllRegisteredTables,
} from "../../migration/ttl-reaper";
import type {
  SecondaryWriteFailureContext,
  SyncRetryEventData,
} from "../../migration/types";
import {
  clearVerifierRegistryForTests,
  listVerifierDomains,
  runParityVerification,
} from "../../migration/verifier";
import { DualAuthRepository } from "./dual.repo";
import { hashSessionToken } from "./mapper";
import { MongoAuthRepository } from "./mongo.repo";
import { PgAuthRepository } from "./pg.repo";
import type { AuthRepository } from "./types";

function makeSessionId(): string {
  return randomUUID().replace(/-/g, "") + randomUUID().replace(/-/g, "");
}

function sha256Base64url(value: string): string {
  return createHash("sha256").update(value).digest("base64url");
}

describe("Phase 1A AuthRepository contract & migration lifecycle (Decision #3)", () => {
  let mongo: MongoMemoryServer;
  let pg: PGlite;
  let db: MakoPgDb;

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([
      User.syncIndexes(),
      OAuthAccount.syncIndexes(),
      Session.syncIndexes(),
      EmailVerification.syncIndexes(),
      DesktopAuthCode.syncIndexes(),
      UserAttribution.syncIndexes(),
    ]);

    pg = createTestPglite();
    await runPgliteMigrations(pg);
    db = drizzle(pg, { schema: pgSchema }) as unknown as MakoPgDb;
  });

  async function cleanAllStores(): Promise<void> {
    await Promise.all([
      User.deleteMany({}),
      UserAttribution.deleteMany({}),
      OAuthAccount.deleteMany({}),
      Session.deleteMany({}),
      EmailVerification.deleteMany({}),
      DesktopAuthCode.deleteMany({}),
    ]);
    await pg.exec(`
      DELETE FROM desktop_auth_codes;
      DELETE FROM email_verifications;
      DELETE FROM sessions;
      DELETE FROM oauth_accounts;
      DELETE FROM user_attributions;
      DELETE FROM users;
      DELETE FROM migration_domain_state;
      DELETE FROM migration_backfill_jobs;
      DELETE FROM migration_tombstones;
      DELETE FROM migration_quarantine;
    `);
  }

  beforeEach(async () => {
    setPgTestDb(db);
    await cleanAllStores();
  });

  afterEach(() => {
    resetPgTestDb();
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
    await pg.close();
  });

  // ── 1. Shared repository behavioral contract (Mongo AND Postgres) ────────

  const implementations: Array<{
    name: string;
    isPg: boolean;
    create: () => AuthRepository;
  }> = [
    {
      name: "MongoAuthRepository",
      isPg: false,
      create: () => new MongoAuthRepository(),
    },
    {
      name: "PgAuthRepository",
      isPg: true,
      create: () => new PgAuthRepository({ getDb: () => db }),
    },
  ];

  for (const impl of implementations) {
    describe(`AuthRepository contract: ${impl.name}`, () => {
      it("creates, queries, batch-fetches, updates, and resolves UUIDv7 + legacy user IDs", async () => {
        const repo = impl.create();
        const createdAt = new Date("2026-11-01T10:00:00.000Z");

        const luciaId = "a1b2c3d4e5f6g7h";
        const legacyUuidV4 = randomUUID();
        const nativeUuidV7 = generateUuidv7();

        const expectedLuciaUuid = legacyUserIdToUuidv7(luciaId, createdAt);
        const expectedV4Uuid = legacyUserIdToUuidv7(legacyUuidV4, createdAt);

        const u1 = await repo.createUser({
          id: luciaId,
          email: "  Alice@Example.COM  ",
          name: "Alice Example",
          hashedPassword: "$2b$10$hashedvalue1",
          emailVerified: false,
          createdAt,
        });
        expect(u1.id).toBe(impl.isPg ? expectedLuciaUuid : luciaId);
        expect(u1._id).toBe(u1.id);
        expect(u1.legacyId).toBe(luciaId);
        expect(u1.email).toBe("alice@example.com");
        expect(u1.name).toBe("Alice Example");
        expect(u1.emailVerified).toBe(false);
        expect(u1.hashedPassword).toBe("$2b$10$hashedvalue1");
        expect(u1.onboarding).toBeUndefined();

        const u2 = await repo.createUser({
          id: legacyUuidV4,
          email: "bob@example.com",
          emailVerified: true,
          createdAt,
          onboarding: {
            role: "developer",
            companySize: "startup",
            completedAt: createdAt,
          },
        });
        expect(u2.id).toBe(impl.isPg ? expectedV4Uuid : legacyUuidV4);
        expect(u2.legacyId).toBe(legacyUuidV4);
        expect(u2.hashedPassword).toBeUndefined();
        expect(u2.onboarding?.role).toBe("developer");

        const u3 = await repo.createUser({
          id: nativeUuidV7,
          email: "carol@example.com",
          emailVerified: true,
          createdAt,
        });
        expect(u3.id).toBe(nativeUuidV7);
        expect(u3.legacyId).toBe(nativeUuidV7);

        // Lookups by legacy id, canonical id, and email (case-insensitive)
        expect((await repo.findUserById(luciaId))?.email).toBe(
          "alice@example.com",
        );
        expect((await repo.findUserById(u1.id))?.email).toBe(
          "alice@example.com",
        );
        expect((await repo.findUserByEmail("ALICE@example.com"))?.id).toBe(
          u1.id,
        );
        expect(await repo.findUserById("nonexistent")).toBeNull();

        // User-ID resolution helpers
        expect(await repo.resolveUserUuid(luciaId)).toBe(expectedLuciaUuid);
        expect(await repo.resolveUserUuid(legacyUuidV4)).toBe(expectedV4Uuid);
        expect(await repo.resolveUserUuid(nativeUuidV7)).toBe(nativeUuidV7);
        expect(await repo.resolveUserUuid("missing-user")).toBeNull();

        const legacyMap = await repo.getUserLegacyIdMap();
        expect(legacyMap.get(luciaId)).toBe(expectedLuciaUuid);
        expect(legacyMap.get(legacyUuidV4)).toBe(expectedV4Uuid);
        expect(legacyMap.has(nativeUuidV7)).toBe(false);

        // Batch lookups
        const byIds = await repo.findUsersByIds([
          luciaId,
          u2.id,
          nativeUuidV7,
          "missing",
        ]);
        expect(byIds.map(u => u.id).sort()).toEqual(
          [u1.id, u2.id, u3.id].sort(),
        );
        expect(await repo.findUsersByIds([])).toEqual([]);

        const byEmails = await repo.findUsersByEmails([
          "ALICE@EXAMPLE.COM",
          "bob@example.com",
          "nobody@example.com",
        ]);
        expect(byEmails.map(u => u.id).sort()).toEqual([u1.id, u2.id].sort());
        expect(await repo.findUsersByEmails([])).toEqual([]);

        // Partial onboarding merge + explicit password & name update
        const cleared = await repo.updateUser(luciaId, {
          emailVerified: true,
          name: "Alice Updated",
          hashedPassword: null,
          onboarding: {
            role: "analyst",
            primaryDatabase: "postgresql",
          },
        });
        expect(cleared?.emailVerified).toBe(true);
        expect(cleared?.name).toBe("Alice Updated");
        expect(cleared?.hashedPassword).toBeUndefined();
        expect(cleared?.onboarding).toEqual({
          role: "analyst",
          primaryDatabase: "postgresql",
        });

        // Second onboarding update merges without wiping prior fields
        const merged = await repo.updateUser(u1.id, {
          onboarding: {
            dataWarehouse: "snowflake",
            completedAt: new Date("2026-11-02T12:00:00.000Z"),
          },
        });
        expect(merged?.onboarding).toEqual({
          role: "analyst",
          primaryDatabase: "postgresql",
          dataWarehouse: "snowflake",
          completedAt: new Date("2026-11-02T12:00:00.000Z"),
        });

        expect(
          await repo.updateUser("does-not-exist", { emailVerified: true }),
        ).toBeNull();
      });

      it("persists user_attributions write-once (idempotent no-op on repeat)", async () => {
        const repo = impl.create();
        const user = await repo.createUser({
          id: "attr_user_00001",
          email: "attr@example.com",
        });

        const capturedAt = new Date("2026-11-10T08:00:00.000Z");
        await repo.upsertAttributionOnce({
          userId: user.id,
          sid: "sid-first",
          gclid: "GCLID-1",
          signupMethod: "google",
          country: "CH",
          firstTouch: {
            landing_page: "/sql",
            utm: { utm_source: "google" },
          },
          lastTouch: { landing_page: "/pricing" },
          capturedAt,
        });

        // Second call must NOT overwrite the first write
        await repo.upsertAttributionOnce({
          userId: user.id,
          sid: "sid-second",
          gclid: "GCLID-2",
          signupMethod: "email",
          country: "US",
          firstTouch: { landing_page: "/changed" },
          lastTouch: { landing_page: "/changed" },
          capturedAt: new Date("2026-11-11T08:00:00.000Z"),
        });

        const stored = await repo.findAttributionByUserId(user.id);
        expect(stored).toEqual({
          userId: user.id,
          sid: "sid-first",
          gclid: "GCLID-1",
          signupMethod: "google",
          country: "CH",
          firstTouch: {
            landing_page: "/sql",
            utm: { utm_source: "google" },
          },
          lastTouch: { landing_page: "/pricing" },
          capturedAt,
        });
      });

      it("manages oauth_accounts with bijective IDs and provider uniqueness", async () => {
        const repo = impl.create();
        const u1 = await repo.createUser({
          id: "oauth_user_0001",
          email: "oauth1@example.com",
        });
        const u2 = await repo.createUser({
          id: generateUuidv7(),
          email: "oauth2@example.com",
        });

        const dual = newDualId();
        const google = await repo.createOAuthAccount({
          id: dual.oid,
          userId: u1.id,
          provider: "google",
          providerUserId: "g-123",
          email: "oauth1@example.com",
        });
        expect(google.id).toBe(dual.oid);

        const github = await repo.createOAuthAccount({
          userId: u2.id,
          provider: "github",
          providerUserId: "gh-456",
          email: "oauth2@example.com",
        });
        expect(github.id).toMatch(/^[0-9a-f]{24}$/);

        expect(
          await repo.findOAuthAccountByProvider("google", "g-123"),
        ).toMatchObject({
          id: dual.oid,
          userId: u1.id,
          provider: "google",
          providerUserId: "g-123",
        });
        expect(
          await repo.findOAuthAccountByProvider("google", "missing"),
        ).toBeNull();

        expect(await repo.findOAuthAccountsByUserId(u1.id)).toHaveLength(1);
        const batch = await repo.findOAuthAccountsByUserIds([u1.id, u2.id]);
        expect(batch).toHaveLength(2);

        // Unique (provider, providerUserId) rejects duplicate
        await expect(
          repo.createOAuthAccount({
            userId: u2.id,
            provider: "google",
            providerUserId: "g-123",
          }),
        ).rejects.toThrow();
      });

      it("creates, refreshes, switches workspace, enforces expiry, and cleans up sessions", async () => {
        const repo = impl.create();
        const user = await repo.createUser({
          id: generateUuidv7(),
          email: "sess@example.com",
        });
        const ws1 = newDualId().oid;
        const ws2 = newDualId().oid;
        const s1Id = makeSessionId();
        const s2Id = makeSessionId();
        const expiredId = makeSessionId();

        const future1 = new Date(Date.now() + 60_000);
        const future2 = new Date(Date.now() + 120_000);
        const past = new Date(Date.now() - 60_000);

        const s1 = await repo.createSession({
          id: s1Id,
          userId: user.id,
          expiresAt: future1,
          activeWorkspaceId: ws1,
        });
        expect(s1.id).toBe(s1Id);
        expect(s1.activeWorkspaceId).toBe(ws1);

        await repo.createSession({
          id: s2Id,
          userId: user.id,
          expiresAt: future1,
        });
        await repo.createSession({
          id: expiredId,
          userId: user.id,
          expiresAt: past,
        });

        await repo.updateSessionExpiry(s1Id, future2);
        const refreshed = await repo.findSessionById(s1Id);
        expect(refreshed?.id).toBe(s1Id);
        expect(refreshed?.expiresAt).toEqual(future2);

        await repo.updateSessionActiveWorkspace(s1Id, ws2);
        expect((await repo.findSessionById(s1Id))?.activeWorkspaceId).toBe(ws2);

        await repo.updateSessionActiveWorkspace(s1Id, null);
        expect(
          (await repo.findSessionById(s1Id))?.activeWorkspaceId,
        ).toBeUndefined();

        await repo.setActiveWorkspaceForUser(user.id, ws1);
        expect((await repo.findSessionById(s1Id))?.activeWorkspaceId).toBe(ws1);
        expect((await repo.findSessionById(s2Id))?.activeWorkspaceId).toBe(ws1);

        if (impl.isPg) {
          // PG enforces expires_at > now() at read time BEFORE reaper runs
          expect(await repo.findSessionById(expiredId)).toBeNull();
        }

        const expiredCount = await repo.deleteExpiredSessions(new Date());
        expect(expiredCount).toBe(1);
        expect(await repo.findSessionById(expiredId)).toBeNull();

        await repo.deleteSession(s1Id);
        expect(await repo.findSessionById(s1Id)).toBeNull();
        expect(await repo.findSessionById(s2Id)).not.toBeNull();

        await repo.deleteUserSessions(user.id);
        expect(await repo.findSessionById(s2Id)).toBeNull();
      });

      it("enforces read-time expiry on email_verifications", async () => {
        const repo = impl.create();
        const now = new Date("2026-11-26T12:00:00.000Z");

        const valid = await repo.createEmailVerification({
          email: "Verify@Example.com",
          code: "123456",
          type: "registration",
          expiresAt: new Date(now.getTime() + 10 * 60_000),
          createdAt: now,
        });
        await repo.createEmailVerification({
          email: "verify@example.com",
          code: "654321",
          type: "registration",
          expiresAt: new Date(now.getTime() - 1000),
          createdAt: now,
        });
        await repo.createEmailVerification({
          email: "verify@example.com",
          code: "999999",
          type: "password_reset",
          expiresAt: new Date(now.getTime() + 10 * 60_000),
          createdAt: now,
        });

        expect(
          await repo.findValidEmailVerification(
            "VERIFY@example.com",
            "123456",
            "registration",
            now,
          ),
        ).toMatchObject({ id: valid.id, code: "123456" });

        // Expired code MUST NOT be returned even before TTL cleanup runs
        expect(
          await repo.findValidEmailVerification(
            "verify@example.com",
            "654321",
            "registration",
            now,
          ),
        ).toBeNull();

        await repo.deleteEmailVerificationById(valid.id);
        expect(
          await repo.findValidEmailVerification(
            "verify@example.com",
            "123456",
            "registration",
            now,
          ),
        ).toBeNull();

        await repo.deleteEmailVerificationsByEmailAndType(
          "verify@example.com",
          "password_reset",
        );
        expect(
          await repo.findValidEmailVerification(
            "verify@example.com",
            "999999",
            "password_reset",
            now,
          ),
        ).toBeNull();
      });

      it("atomically redeems desktop_auth_codes exactly once", async () => {
        const repo = impl.create();
        const user = await repo.createUser({
          id: "desk_user_00001",
          email: "desk@example.com",
        });
        const codeHash = sha256Base64url(randomBytes(32).toString("base64url"));
        const challenge = sha256Base64url(
          "my-secret-verifier-value-1234567890",
        );

        await repo.createDesktopAuthCode({
          id: codeHash,
          userId: user.id,
          challenge,
          expiresAt: new Date(Date.now() + 60_000),
        });

        const [r1, r2, r3] = await Promise.all([
          repo.redeemAndDeleteDesktopAuthCode(codeHash),
          repo.redeemAndDeleteDesktopAuthCode(codeHash),
          repo.redeemAndDeleteDesktopAuthCode(codeHash),
        ]);
        const winners = [r1, r2, r3].filter(Boolean);
        expect(winners).toHaveLength(1);
        expect(winners[0]?.userId).toBe(user.id);
        expect(winners[0]?.challenge).toBe(challenge);

        expect(await repo.redeemAndDeleteDesktopAuthCode(codeHash)).toBeNull();
      });
    });
  }

  // ── 2. Postgres hashed-token sessions, UUIDv7 actor IDs & schema cascades ─

  it("stores ONLY sha256(token) in Postgres sessions, coerces corrupt workspace IDs, cascades deletes, and classifies UUIDv7 person actors", async () => {
    const pgRepo = new PgAuthRepository({ getDb: () => db });
    const user = await pgRepo.createUser({
      id: "cascade_user_01",
      email: "cascade@example.com",
    });
    expect(isUuidv7(user.id)).toBe(true);
    expect(isPersonActorId(user.id)).toBe(true);
    expect(isPersonActorId(generateUuidv7())).toBe(true);
    expect(isPersonActorId("a1b2c3d4e5f6g7h")).toBe(true);
    expect(isPersonActorId("api-key")).toBe(false);

    const rawToken = makeSessionId();
    const expectedHash = hashSessionToken(rawToken);
    const s = await pgRepo.createSession({
      id: rawToken,
      userId: user.id,
      expiresAt: new Date(Date.now() + 60_000),
      activeWorkspaceId: "not-a-valid-objectid",
    });
    expect(s.id).toBe(rawToken);
    expect(s.tokenHash).toBe(expectedHash);
    expect(s.activeWorkspaceId).toBeUndefined();

    // Verify raw bearer token is NEVER stored in Postgres — only token_hash
    const rawRows = await db.select().from(pgSchema.sessions);
    expect(rawRows).toHaveLength(1);
    expect(rawRows[0].tokenHash).toBe(expectedHash);
    expect(JSON.stringify(rawRows[0])).not.toContain(rawToken);

    // Lookup by raw token returns id === rawToken (for sliding cookie refresh)
    const found = await pgRepo.findSessionById(rawToken);
    expect(found?.id).toBe(rawToken);
    expect(found?.tokenHash).toBe(expectedHash);
    // Lookup by the hash itself MUST NOT validate a session
    expect(await pgRepo.findSessionById(expectedHash)).toBeNull();

    await pgRepo.upsertAttributionOnce({
      userId: user.id,
      signupMethod: "email",
      firstTouch: {},
      lastTouch: {},
    });
    await pgRepo.createOAuthAccount({
      userId: user.id,
      provider: "github",
      providerUserId: "gh-cascade",
    });
    await pgRepo.createDesktopAuthCode({
      id: sha256Base64url("cascade-code"),
      userId: user.id,
      challenge: sha256Base64url("cascade-verifier"),
      expiresAt: new Date(Date.now() + 60_000),
    });

    // Deleting user cascades to all child auth tables (all uuid FKs)
    await db.delete(pgSchema.users).where(eq(pgSchema.users.id, user.id));
    expect(await pgRepo.findSessionById(rawToken)).toBeNull();
    expect(await pgRepo.findAttributionByUserId(user.id)).toBeNull();
    expect(await pgRepo.findOAuthAccountsByUserId(user.id)).toEqual([]);
    expect(
      await pgRepo.redeemAndDeleteDesktopAuthCode(
        sha256Base64url("cascade-code"),
      ),
    ).toBeNull();
  });

  // ── 3. 5-stage DualAuthRepository + empty-start sessions + Stage 4->2 rollback ─

  it("executes all 5 stages with Mongo-only (1–3) / PG-only (4–5) sessions, shadow match for legacy & UUIDv7 users, and zero-loss Stage 4 -> Stage 2 rollback", async () => {
    const shadowEvents: ShadowCompareEvent[] = [];
    const failures: SecondaryWriteFailureContext[] = [];
    const shadowRunner = new ShadowCompareRunner({
      maxInflight: 8,
      onEvent: e => shadowEvents.push(e),
    });
    const router = new MigrationRouter({
      enablePubSub: false,
      shadowRunner,
      rng: () => 0.0,
      onSecondaryFailure: async ctx => {
        failures.push(ctx);
      },
    });
    const mongoRepo = new MongoAuthRepository();
    const pgRepo = new PgAuthRepository({ getDb: () => db });
    const dual = new DualAuthRepository({
      mongo: mongoRepo,
      pg: pgRepo,
      router,
      getDb: () => db,
    });

    // Stage 1: mongo_only
    const u1 = await dual.createUser({
      id: "stage1_user_001",
      email: "stage1@example.com",
      hashedPassword: "pw1",
      emailVerified: true,
    });
    expect(await mongoRepo.findUserById(u1.id)).not.toBeNull();
    expect(await pgRepo.findUserById(u1.id)).toBeNull();

    // Stage 2: dual_write_mongo_read
    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_mongo_read",
    });

    // New user (no id passed) mints ONE UUIDv7 written to BOTH Mongo and PG
    const u2New = await dual.createUser({
      email: "stage2-new@example.com",
      hashedPassword: "pw2new",
      emailVerified: true,
    });
    expect(isUuidv7(u2New.id)).toBe(true);
    expect((await mongoRepo.findUserById(u2New.id))?.id).toBe(u2New.id);
    expect((await pgRepo.findUserById(u2New.id))?.id).toBe(u2New.id);

    // Legacy user ID written to Mongo (_id = legacy) and PG (id = deterministic UUIDv7, legacy_id = legacy)
    const u2Legacy = await dual.createUser({
      id: "stage2_user_001",
      email: "stage2@example.com",
      hashedPassword: "pw2",
      emailVerified: false,
    });
    const u2LegacyPg = await pgRepo.findUserById("stage2_user_001");
    expect(u2LegacyPg).not.toBeNull();
    if (!u2LegacyPg) throw new Error("Expected u2LegacyPg to exist");
    expect(isUuidv7(u2LegacyPg.id)).toBe(true);
    expect(u2LegacyPg.legacyId).toBe("stage2_user_001");

    await dual.createOAuthAccount({
      userId: u2Legacy.id,
      provider: "github",
      providerUserId: "gh-stage2-legacy",
      email: u2Legacy.email,
    });

    // Decision #3: Stage 2 sessions run against Mongo ONLY — PG sessions stays EMPTY
    const wsOid = newDualId().oid;
    const s2Id = makeSessionId();
    await dual.createSession({
      id: s2Id,
      userId: u2Legacy.id,
      expiresAt: new Date(Date.now() + 60_000),
      activeWorkspaceId: wsOid,
    });
    expect(await mongoRepo.findSessionById(s2Id)).not.toBeNull();
    expect(await pgRepo.findSessionById(s2Id)).toBeNull();
    expect(await db.select().from(pgSchema.sessions)).toHaveLength(0);

    // Stage 2 delete on email_verifications records tombstone in migration_tombstones
    const evToDelete = await dual.createEmailVerification({
      email: "tombstone@example.com",
      code: "112233",
      type: "registration",
      expiresAt: new Date(Date.now() + 300_000),
    });
    await dual.deleteEmailVerificationById(evToDelete.id);
    const tombstones = await db.select().from(pgSchema.migrationTombstones);
    expect(tombstones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "email_verifications",
          entityId: evToDelete.id.toLowerCase(),
        }),
      ]),
    );
    // Deleting a session in Stage 2 creates NO tombstone (sessions never backfilled)
    await dual.deleteSession(s2Id);
    const sessTombstones = (
      await db.select().from(pgSchema.migrationTombstones)
    ).filter(t => t.tableName === "sessions");
    expect(sessTombstones).toHaveLength(0);

    // Stage 3: dual_write_shadow_compare (100% sampling)
    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 1,
    });

    // Create a Stage 3 Mongo session (will be logged out on Stage 4 cutover)
    const s3MongoOnlyId = makeSessionId();
    await dual.createSession({
      id: s3MongoOnlyId,
      userId: u2Legacy.id,
      expiresAt: new Date(Date.now() + 300_000),
    });
    expect(await db.select().from(pgSchema.sessions)).toHaveLength(0);

    const v = await dual.createEmailVerification({
      email: "stage2@example.com",
      code: "777888",
      type: "registration",
      expiresAt: new Date(Date.now() + 300_000),
    });

    // Shadow compare matches for both new UUIDv7 user AND legacy Lucia user + OAuth lookup
    expect((await dual.findUserById(u2New.id))?.id).toBe(u2New.id);
    expect((await dual.findUserById(u2Legacy.id))?.id).toBe("stage2_user_001");
    expect(
      (await dual.findOAuthAccountByProvider("github", "gh-stage2-legacy"))
        ?.userId,
    ).toBe("stage2_user_001");
    await shadowRunner.flush();
    expect(shadowEvents.slice(-3).every(e => e.result === "match")).toBe(true);

    // Inject deliberate secret drift in PG verification code -> verify redaction
    await db
      .update(pgSchema.emailVerifications)
      .set({ code: "000000" })
      .where(eq(pgSchema.emailVerifications.id, v.id));

    await dual.findValidEmailVerification(
      "stage2@example.com",
      "777888",
      "registration",
    );
    await shadowRunner.flush();
    const mismatchEvent = shadowEvents.at(-1);
    expect(mismatchEvent?.result).toBe("mismatch");
    expect(JSON.stringify(mismatchEvent)).not.toContain("777888");

    // Stage 4: dual_write_pg_read (PG primary + Mongo secondary)
    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_pg_read",
      shadowSampleRate: 1,
    });

    // Decision #3: Pre-cutover Mongo session is invalid in Stage 4 (clean one-time logout)
    expect(await dual.findSessionById(s3MongoOnlyId)).toBeNull();

    // New user created in Stage 4 gets identical UUIDv7 in PG & Mongo
    const u4New = await dual.createUser({
      email: "stage4@example.com",
      hashedPassword: "pw4",
      emailVerified: true,
    });
    expect(isUuidv7(u4New.id)).toBe(true);

    const oauth4 = await dual.createOAuthAccount({
      userId: u4New.id,
      provider: "google",
      providerUserId: "g-stage4",
      email: "stage4@example.com",
    });

    // Update & add attribution to LEGACY user via their PG UUID in Stage 4 -> reverse-syncs to Mongo legacy _id!
    const updatedLegacy = await dual.updateUser(u2LegacyPg.id, {
      onboarding: { role: "staff-engineer" },
    });
    expect(updatedLegacy?.onboarding?.role).toBe("staff-engineer");
    await dual.upsertAttributionOnce({
      userId: u2LegacyPg.id,
      signupMethod: "github",
      gclid: "G-STAGE4-LEGACY",
      firstTouch: { landing_page: "/legacy" },
      lastTouch: { landing_page: "/legacy" },
    });

    // Stage 4 session writes ONLY to PG hashed-token table (NOT Mongo)
    const s4PgOnlyId = makeSessionId();
    const s4 = await dual.createSession({
      id: s4PgOnlyId,
      userId: u4New.id,
      expiresAt: new Date(Date.now() + 120_000),
      activeWorkspaceId: wsOid,
    });
    expect(s4.id).toBe(s4PgOnlyId);
    expect(s4.tokenHash).toBe(hashSessionToken(s4PgOnlyId));
    expect(await mongoRepo.findSessionById(s4PgOnlyId)).toBeNull();

    // Stage 4 reverse shadow compare matches for BOTH new UUIDv7 user AND legacy user looked up by PG UUID!
    expect((await dual.findUserById(u4New.id))?.email).toBe(
      "stage4@example.com",
    );
    expect((await dual.findUserById(u2LegacyPg.id))?.onboarding?.role).toBe(
      "staff-engineer",
    );
    expect((await dual.findAttributionByUserId(u2LegacyPg.id))?.gclid).toBe(
      "G-STAGE4-LEGACY",
    );
    await shadowRunner.flush();
    expect(shadowEvents.slice(-3).every(e => e.result === "match")).toBe(true);

    // INSTANT ROLLBACK: Stage 4 -> Stage 2 -> every Stage 4 non-session write exists in Mongo!
    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_mongo_read",
    });
    expect(await dual.findUserById(u4New.id)).toMatchObject({
      id: u4New.id,
      email: "stage4@example.com",
    });
    expect(await dual.findOAuthAccountByProvider("google", "g-stage4")).toEqual(
      oauth4,
    );
    expect((await dual.findUserById("stage2_user_001"))?.onboarding?.role).toBe(
      "staff-engineer",
    );
    expect((await dual.findAttributionByUserId("stage2_user_001"))?.gclid).toBe(
      "G-STAGE4-LEGACY",
    );

    // Stage 5: pg_only
    await router.setDomainState({ domain: "auth", mode: "pg_only" });
    const u5 = await dual.createUser({
      email: "stage5@example.com",
      emailVerified: true,
    });
    expect(isUuidv7(u5.id)).toBe(true);
    expect(await pgRepo.findUserById(u5.id)).not.toBeNull();
    expect(await mongoRepo.findUserById(u5.id)).toBeNull();

    expect(failures).toHaveLength(0);
  });

  // ── 4. Secondary failure isolation + zero session retry payloads ─────────

  it("isolates secondary failures on non-session tables, heals via sync-retry in both directions, and never emits session retry payloads", async () => {
    const captured: SecondaryWriteFailureContext[] = [];
    const router = new MigrationRouter({
      enablePubSub: false,
      onSecondaryFailure: async ctx => {
        captured.push(ctx);
      },
    });
    const mongoRepo = new MongoAuthRepository();
    const brokenPgRepo = new PgAuthRepository({
      getDb: () => {
        throw new Error("Simulated PG outage");
      },
    });

    const dualBrokenPg = new DualAuthRepository({
      mongo: mongoRepo,
      pg: brokenPgRepo,
      router,
      getDb: () => db,
    });

    // Stage 2: Mongo succeeds while PG fails
    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_mongo_read",
    });

    const legacyUser = await dualBrokenPg.createUser({
      id: "retry_user_0001",
      email: "retry@example.com",
      emailVerified: true,
    });
    expect(legacyUser.id).toBe("retry_user_0001");
    expect(captured).toHaveLength(1);
    expect(captured[0].target).toBe("pg");

    // Session CRUD during Stage 2 PG outage succeeds against Mongo with ZERO retry payloads!
    const rawSessionToken = makeSessionId();
    await dualBrokenPg.createSession({
      id: rawSessionToken,
      userId: legacyUser.id,
      expiresAt: new Date(Date.now() + 60_000),
    });
    await dualBrokenPg.updateSessionExpiry(
      rawSessionToken,
      new Date(Date.now() + 120_000),
    );
    await dualBrokenPg.deleteSession(rawSessionToken);
    expect(captured).toHaveLength(1); // zero session failures emitted
    expect(JSON.stringify(captured)).not.toContain(rawSessionToken);

    // PG is missing the user before replay
    const pgRepo = new PgAuthRepository({ getDb: () => db });
    expect(await pgRepo.findUserById("retry_user_0001")).toBeNull();

    // Replay into PG via registered sync-retry handler
    const pgRetryEvent: SyncRetryEventData = {
      target: "pg",
      domain: captured[0].domain,
      operation: captured[0].operation,
      entityId: captured[0].entityId ?? "unknown",
      payload: captured[0].payload,
      failedAt: new Date().toISOString(),
      errorMessage: "Simulated PG outage",
    };
    await replayAuthWriteToPg(pgRetryEvent, db);
    const replayedPgUser = await pgRepo.findUserById("retry_user_0001");
    expect(replayedPgUser).not.toBeNull();
    if (!replayedPgUser) throw new Error("Expected replayedPgUser to exist");
    expect(replayedPgUser.legacyId).toBe("retry_user_0001");

    // Stage 4: PG succeeds while Mongo fails -> replayAuthWriteToMongo heals Mongo using legacy_id!
    const brokenMongo = Object.create(mongoRepo) as MongoAuthRepository;
    brokenMongo.updateUser = async () => {
      throw new Error("Simulated Mongo outage");
    };
    const dualBrokenMongo = new DualAuthRepository({
      mongo: brokenMongo,
      pg: pgRepo,
      router,
      getDb: () => db,
    });

    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_pg_read",
    });

    const updated = await dualBrokenMongo.updateUser(replayedPgUser.id, {
      onboarding: { role: "founder" },
    });
    expect(updated?.onboarding?.role).toBe("founder");
    expect(captured).toHaveLength(2);
    expect(captured[1].target).toBe("mongo");

    expect(
      (await mongoRepo.findUserById("retry_user_0001"))?.onboarding,
    ).toBeUndefined();

    await replayAuthWriteToMongo(
      {
        target: "mongo",
        domain: captured[1].domain,
        operation: captured[1].operation,
        entityId: captured[1].entityId ?? "unknown",
        payload: captured[1].payload,
        failedAt: new Date().toISOString(),
        errorMessage: "Simulated Mongo outage",
      },
      db,
    );
    expect(
      (await mongoRepo.findUserById("retry_user_0001"))?.onboarding?.role,
    ).toBe("founder");
  });

  // ── 5. FK-ordered Backfill (5 tables, NO sessions), Verifier --repair, TTL Reaper ─

  it("backfills 5 auth tables (excluding sessions) in FK order, preserves minted UUIDv7s, guards stale/tombstones/orphans, repairs parity, and reaps TTLs", async () => {
    clearBackfillRegistryForTests();
    clearVerifierRegistryForTests();
    clearTtlRegistryForTests();
    registerMigrationDomains({ force: true });

    // Confirm `sessions` is intentionally absent from backfill & verifier domains
    expect(
      listBackfillDomains()
        .filter(d => d === "auth" || d.startsWith("auth:"))
        .sort(),
    ).toEqual([
      "auth",
      "auth:desktop_auth_codes",
      "auth:email_verifications",
      "auth:oauth_accounts",
      "auth:user_attributions",
      "auth:users",
    ]);
    expect(
      listVerifierDomains()
        .filter(d => d === "auth" || d.startsWith("auth:"))
        .sort(),
    ).toEqual([
      "auth",
      "auth:desktop_auth_codes",
      "auth:email_verifications",
      "auth:oauth_accounts",
      "auth:user_attributions",
      "auth:users",
    ]);

    const t0 = new Date("2026-11-20T10:00:00.000Z");
    const tNewer = new Date("2026-11-20T11:00:00.000Z");
    const futureShort = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    const expiredAt = new Date("2026-11-01T00:00:00.000Z");
    const mintedUuidV7 = generateUuidv7(t0.getTime());

    // Seed MongoDB directly across users (legacy Lucia + legacy stale + newly minted UUIDv7)
    await User.create([
      {
        _id: "u_01_normal",
        email: "normal@example.com",
        hashedPassword: "h1",
        emailVerified: true,
        onboarding: { role: "engineer", completedAt: t0 },
        createdAt: t0,
        updatedAt: t0,
      },
      {
        _id: "u_02_stale_in_mongo",
        email: "stale@example.com",
        hashedPassword: "old-password",
        emailVerified: false,
        createdAt: t0,
        updatedAt: t0,
      },
      {
        _id: mintedUuidV7,
        email: "minted-v7@example.com",
        emailVerified: true,
        createdAt: t0,
        updatedAt: t0,
      },
    ]);

    const u1PgUuid = legacyUserIdToUuidv7("u_01_normal", t0);

    // Pre-populate PG with a NEWER version of u_02 (simulating live dual-write)
    const pgRepo = new PgAuthRepository({ getDb: () => db });
    await pgRepo.createUser({
      id: "u_02_stale_in_mongo",
      email: "stale@example.com",
      hashedPassword: "live-newer-password",
      emailVerified: true,
      createdAt: t0,
      updatedAt: tNewer,
    });

    // Attributions (1 valid + 1 orphan pointing to missing user)
    await UserAttribution.create([
      {
        _id: "u_01_normal",
        sid: "sid-1",
        gclid: "G-1",
        signupMethod: "email",
        country: "CH",
        firstTouch: { landing_page: "/home" },
        lastTouch: { landing_page: "/signup" },
        capturedAt: t0,
      },
      {
        _id: "u_99_orphan",
        signupMethod: "email",
        firstTouch: {},
        lastTouch: {},
        capturedAt: t0,
      },
    ]);

    // OAuth accounts (1 valid + 1 orphan)
    const oauthValidId = newDualId(t0.getTime());
    await OAuthAccount.create([
      {
        _id: new mongoose.Types.ObjectId(oauthValidId.oid),
        userId: "u_01_normal",
        provider: "google",
        providerUserId: "google-u01",
        email: "normal@example.com",
        createdAt: t0,
      },
      {
        _id: new mongoose.Types.ObjectId(newDualId(t0.getTime() + 1000).oid),
        userId: "u_99_orphan",
        provider: "github",
        providerUserId: "gh-orphan",
        createdAt: t0,
      },
    ]);

    // Mongo Sessions — MUST NOT be copied into PG during backfill (Decision #3)
    await Session.create({
      _id: makeSessionId(),
      userId: "u_01_normal",
      expiresAt: futureShort,
    });

    // Email verifications (1 valid + 1 expired + 1 tombstoned)
    const evValidId = randomUUID();
    const evExpiredId = randomUUID();
    const evTombstonedId = randomUUID();
    await recordMigrationTombstone("email_verifications", evTombstonedId, db);
    await EmailVerification.create([
      {
        _id: evValidId,
        email: "normal@example.com",
        code: "111222",
        type: "registration",
        expiresAt: futureShort,
        createdAt: t0,
      },
      {
        _id: evExpiredId,
        email: "normal@example.com",
        code: "333444",
        type: "password_reset",
        expiresAt: expiredAt,
        createdAt: t0,
      },
      {
        _id: evTombstonedId,
        email: "normal@example.com",
        code: "555666",
        type: "registration",
        expiresAt: futureShort,
        createdAt: t0,
      },
    ]);

    // Desktop auth codes with mixed-case base64url hash (1 valid + 1 expired + 1 tombstoned + 1 orphan)
    const codeValidHash = "AbCdEfGhIjKlMnOpQrStUvWxYz0123456789-_AbCdE";
    const codeExpiredHash = "ZyXwVuTsRqPoNmLkJiHgFeDcBa9876543210_-ZyXwV";
    const codeTombstonedHash = "QqWwEeRrTtYyUuIiOoPpAaSsDdFfGgHhJjKkLl-_012";
    const codeOrphanHash = "OrPhAnHash0123456789-_AaBbCcDdEeFfGgHhIiJjK";
    await recordMigrationTombstone(
      "desktop_auth_codes",
      codeTombstonedHash,
      db,
    );
    await DesktopAuthCode.create([
      {
        _id: codeValidHash,
        userId: "u_01_normal",
        challenge: sha256Base64url("v-valid"),
        expiresAt: futureShort,
        createdAt: t0,
      },
      {
        _id: codeExpiredHash,
        userId: "u_01_normal",
        challenge: sha256Base64url("v-expired"),
        expiresAt: expiredAt,
        createdAt: t0,
      },
      {
        _id: codeTombstonedHash,
        userId: "u_01_normal",
        challenge: sha256Base64url("v-tombstoned"),
        expiresAt: futureShort,
        createdAt: t0,
      },
      {
        _id: codeOrphanHash,
        userId: "u_99_orphan",
        challenge: sha256Base64url("v-orphan"),
        expiresAt: futureShort,
        createdAt: t0,
      },
    ]);

    // Pause after 2 batches of 3, then resume to completion
    const pass1 = await runBackfill({
      domain: "auth",
      batchSize: 3,
      maxBatches: 2,
      db,
    });
    expect(pass1.status).toBe("paused");
    expect(pass1.batchesRun).toBe(2);

    const pass2 = await runBackfill({
      domain: "auth",
      batchSize: 3,
      db,
    });
    expect(pass2.status).toBe("completed");
    expect(pass2.rowsSkippedTombstone).toBe(2);
    expect(pass2.rowsQuarantined).toBe(3); // 3 orphan records

    // PG sessions table MUST STILL BE EMPTY after backfill!
    expect(await db.select().from(pgSchema.sessions)).toHaveLength(0);

    // Newly minted UUIDv7 user kept its minted UUIDv7 verbatim (not re-hashed!)
    const mintedPg = await pgRepo.findUserById(mintedUuidV7);
    expect(mintedPg?.id).toBe(mintedUuidV7);
    expect(mintedPg?.legacyId).toBe(mintedUuidV7);

    // Legacy user mapped deterministically with legacy_id preserved
    const u1Pg = await pgRepo.findUserById("u_01_normal");
    expect(u1Pg?.id).toBe(u1PgUuid);
    expect(u1Pg?.legacyId).toBe("u_01_normal");

    // Stale updatedAt guard protected live PG user u_02
    const u2Pg = await pgRepo.findUserById("u_02_stale_in_mongo");
    expect(u2Pg?.hashedPassword).toBe("live-newer-password");
    expect(u2Pg?.emailVerified).toBe(true);

    // Tombstoned email verification & mixed-case desktop auth code NOT resurrected
    expect(
      await pgRepo.findEmailVerificationById(evTombstonedId, db),
    ).toBeNull();
    expect(
      await pgRepo.findDesktopAuthCodeById(codeTombstonedHash, db),
    ).toBeNull();

    // OAuth account ObjectId -> UUIDv8 -> wire roundtrip & uuid user_id FK
    const oauthRow = await db
      .select()
      .from(pgSchema.oauthAccounts)
      .where(eq(pgSchema.oauthAccounts.id, objectIdToUuid(oauthValidId.oid)));
    expect(oauthRow).toHaveLength(1);
    expect(toWireId(oauthRow[0].id)).toBe(oauthValidId.oid);
    expect(oauthRow[0].userId).toBe(u1PgUuid);

    // Re-upserting an existing oauth_accounts row is idempotent (no PK conflict!)
    expect(
      await pgRepo.upsertOAuthAccountIdempotent(
        {
          id: oauthValidId.oid,
          userId: "u_01_normal",
          provider: "google",
          providerUserId: "google-u01",
          email: "normal@example.com",
          createdAt: t0,
        },
        u1PgUuid,
        db,
      ),
    ).toBe(true);

    // Mixed-case desktop auth code preserved verbatim
    expect(
      await pgRepo.findDesktopAuthCodeById(codeValidHash, db),
    ).not.toBeNull();

    // Quarantine table recorded all 3 orphans
    const quarantined = await db.select().from(pgSchema.migrationQuarantine);
    expect(quarantined).toHaveLength(3);
    expect(quarantined.every(q => q.reason === "orphaned_user_missing")).toBe(
      true,
    );

    // Remove orphans & sync u_02 so we can test verifier parity + --repair
    await Promise.all([
      UserAttribution.deleteOne({ _id: "u_99_orphan" }),
      OAuthAccount.deleteOne({ userId: "u_99_orphan" }),
      DesktopAuthCode.deleteOne({ _id: codeOrphanHash }),
      User.updateOne(
        { _id: "u_02_stale_in_mongo" },
        {
          $set: {
            hashedPassword: "live-newer-password",
            emailVerified: true,
            updatedAt: tNewer,
          },
        },
        { timestamps: false },
      ),
    ]);

    // Deliberately introduce drift in PG (delete email_verification + corrupt user role + drift oauth email)
    await db
      .delete(pgSchema.emailVerifications)
      .where(eq(pgSchema.emailVerifications.id, evValidId));
    await db
      .update(pgSchema.users)
      .set({ onboardingRole: "corrupted-role" })
      .where(eq(pgSchema.users.id, u1PgUuid));
    await db
      .update(pgSchema.oauthAccounts)
      .set({ email: "drifted@example.com" })
      .where(eq(pgSchema.oauthAccounts.id, objectIdToUuid(oauthValidId.oid)));

    const driftReport = await runParityVerification({
      domain: "auth",
      batchSize: 4,
      repair: true,
      db,
    });
    expect(driftReport.ok).toBe(false);
    expect(driftReport.skippedTombstone).toBe(2);
    expect(driftReport.missingInPg).toBe(1);
    expect(driftReport.mismatched).toBe(2);
    expect(driftReport.repaired).toBe(3);

    // Re-verify after repair -> 100% clean parity across all 5 migrated tables!
    const cleanReport = await runParityVerification({
      domain: "auth",
      batchSize: 4,
      db,
    });
    expect(cleanReport.ok).toBe(true);
    expect(cleanReport.missingInPg).toBe(0);
    expect(cleanReport.mismatched).toBe(0);
    expect(cleanReport.extraInPg).toBe(0);
    expect(cleanReport.skippedTombstone).toBe(2);

    // Verify TTL reaper rules registered for all 3 ephemeral auth tables & reap expired rows
    const ruleTables = listTtlRules()
      .map(r => r.tableName)
      .sort();
    expect(ruleTables).toEqual(
      expect.arrayContaining([
        "desktop_auth_codes",
        "email_verifications",
        "sessions",
      ]),
    );

    // Insert 1 active + 1 expired PG hashed-token session directly (simulating post-cutover sessions)
    const activePgSessionToken = makeSessionId();
    const expiredPgSessionToken = makeSessionId();
    await pgRepo.createSession({
      id: activePgSessionToken,
      userId: u1PgUuid,
      expiresAt: futureShort,
    });
    await pgRepo.createSession({
      id: expiredPgSessionToken,
      userId: u1PgUuid,
      expiresAt: expiredAt,
    });

    const reapNow = new Date(Date.now() + 60_000);
    const reapRes = await reapAllRegisteredTables({ db, now: reapNow });
    expect(Object.keys(reapRes.errors)).toHaveLength(0);
    const deletedByTable = new Map(
      reapRes.results.map(r => [r.tableName, r.deleted]),
    );
    expect(deletedByTable.get("sessions")).toBe(1);
    expect(deletedByTable.get("email_verifications")).toBe(1);
    expect(deletedByTable.get("desktop_auth_codes")).toBe(1);

    // Unexpired rows remain intact
    expect(await pgRepo.findSessionById(activePgSessionToken)).not.toBeNull();
    expect(
      await pgRepo.findEmailVerificationById(evValidId, db),
    ).not.toBeNull();
    expect(
      await pgRepo.findDesktopAuthCodeById(codeValidHash, db),
    ).not.toBeNull();
  });

  // ── 6. Verifier #28 regression tests ─────────────────────────────────────

  it("preserves legacy users.name across mongo_only, PG, backfill, and git authorForUser", async () => {
    clearBackfillRegistryForTests();
    clearVerifierRegistryForTests();
    registerMigrationDomains({ force: true });

    const now = new Date("2026-11-25T10:00:00.000Z");
    const legacyId = "legacy_name_u01";
    await User.collection.insertOne({
      _id: legacyId as unknown as mongoose.Types.ObjectId,
      email: "ada@example.com",
      name: "Ada Lovelace",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    // mongo_only default path (authorForUser) preserves legacy user.name
    const gitAuthor = await authorForUser(legacyId);
    expect(gitAuthor).toEqual({
      name: "Ada Lovelace",
      email: "ada@example.com",
    });

    // Backfill & verifier preserve users.name into Postgres
    const backfill = await runBackfill({ domain: "auth", batchSize: 10, db });
    expect(backfill.status).toBe("completed");

    const pgRepo = new PgAuthRepository({ getDb: () => db });
    const pgUser = await pgRepo.findUserById(legacyId);
    expect(pgUser?.name).toBe("Ada Lovelace");
    expect(pgUser?.legacyId).toBe(legacyId);
    expect(isUuidv7(pgUser?.id)).toBe(true);

    const report = await runParityVerification({
      domain: "auth",
      batchSize: 10,
      db,
    });
    expect(report.ok).toBe(true);
  });

  it("advances monotonically past legacy non-ObjectId string _ids in oauthaccounts without looping", async () => {
    clearBackfillRegistryForTests();
    registerMigrationDomains({ force: true });

    const now = new Date("2026-11-25T10:00:00.000Z");
    await User.create({
      _id: "oauth_loop_u01",
      email: "oauthloop@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    const expectedUserUuid = legacyUserIdToUuidv7("oauth_loop_u01", now);

    const validOid = newDualId(now.getTime()).oid;
    await OAuthAccount.collection.insertMany([
      {
        _id: "legacy-string-oauth-id" as unknown as mongoose.Types.ObjectId,
        userId: "oauth_loop_u01",
        provider: "google",
        providerUserId: "legacy-str-uid",
        createdAt: now,
      },
      {
        _id: new mongoose.Types.ObjectId(validOid),
        userId: "oauth_loop_u01",
        provider: "github",
        providerUserId: "valid-oid-uid",
        createdAt: now,
      },
    ]);

    // batchSize: 1 forces cursor checkpoint directly on the non-ObjectId string _id
    const summary = await runBackfill({
      domain: "auth",
      batchSize: 1,
      maxBatches: 20,
      db,
    });
    expect(summary.status).toBe("completed");
    expect(summary.rowsQuarantined).toBe(1);

    const pgRepo = new PgAuthRepository({ getDb: () => db });
    expect(
      await pgRepo.findOAuthAccountByProvider("github", "valid-oid-uid"),
    ).toMatchObject({ id: validOid, userId: expectedUserUuid });
  });

  // ── 7. Verifier #41 regression tests (critical-path read overhead & injected DB) ─

  it("issues ZERO extra PG queries on critical read paths in Stage 3 and Stage 4 when unsampled", async () => {
    const shadowEvents: ShadowCompareEvent[] = [];
    const shadowRunner = new ShadowCompareRunner({
      maxInflight: 8,
      onEvent: e => shadowEvents.push(e),
    });
    let rngValue = 0.0;
    const router = new MigrationRouter({
      enablePubSub: false,
      shadowRunner,
      rng: () => rngValue,
    });
    const mongoRepo = new MongoAuthRepository();
    const pgRepo = new PgAuthRepository({ getDb: () => db });

    // Wrap PG read methods with call counters to verify zero extra critical-path queries
    const counts = {
      findUserById: 0,
      findUsersByIds: 0,
      findAttributionByUserId: 0,
      findOAuthAccountByProvider: 0,
      findOAuthAccountsByUserId: 0,
      findOAuthAccountsByUserIds: 0,
      resolveUserUuid: 0,
    };
    const countedPg = Object.create(pgRepo) as PgAuthRepository;
    countedPg.findUserById = (...args) => {
      counts.findUserById += 1;
      return pgRepo.findUserById(...args);
    };
    countedPg.findUsersByIds = (...args) => {
      counts.findUsersByIds += 1;
      return pgRepo.findUsersByIds(...args);
    };
    countedPg.findAttributionByUserId = (...args) => {
      counts.findAttributionByUserId += 1;
      return pgRepo.findAttributionByUserId(...args);
    };
    countedPg.findOAuthAccountByProvider = (...args) => {
      counts.findOAuthAccountByProvider += 1;
      return pgRepo.findOAuthAccountByProvider(...args);
    };
    countedPg.findOAuthAccountsByUserId = (...args) => {
      counts.findOAuthAccountsByUserId += 1;
      return pgRepo.findOAuthAccountsByUserId(...args);
    };
    countedPg.findOAuthAccountsByUserIds = (...args) => {
      counts.findOAuthAccountsByUserIds += 1;
      return pgRepo.findOAuthAccountsByUserIds(...args);
    };
    countedPg.resolveUserUuid = (...args) => {
      counts.resolveUserUuid += 1;
      return pgRepo.resolveUserUuid(...args);
    };

    const dual = new DualAuthRepository({
      mongo: mongoRepo,
      pg: countedPg,
      router,
      getDb: () => db,
    });

    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_mongo_read",
    });
    const legacyId = "perf_legacy_u01";
    await dual.createUser({
      id: legacyId,
      email: "perf@example.com",
      emailVerified: true,
    });
    await dual.upsertAttributionOnce({
      userId: legacyId,
      signupMethod: "google",
      firstTouch: {},
      lastTouch: {},
    });
    await dual.createOAuthAccount({
      userId: legacyId,
      provider: "google",
      providerUserId: "g-perf-1",
      email: "perf@example.com",
    });

    const pgUser = await pgRepo.findUserById(legacyId);
    if (!pgUser) throw new Error("Expected pgUser to exist");

    // Stage 3 when read is not sampled (rng >= shadowSampleRate) -> ZERO PG calls across every read method!
    rngValue = 0.99;
    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 0.5,
    });
    for (const k of Object.keys(counts) as Array<keyof typeof counts>) {
      counts[k] = 0;
    }

    expect((await dual.findUserById(legacyId))?.id).toBe(legacyId);
    expect(await dual.findUsersByIds([legacyId])).toHaveLength(1);
    expect(await dual.findAttributionByUserId(legacyId)).not.toBeNull();
    expect(
      await dual.findOAuthAccountByProvider("google", "g-perf-1"),
    ).not.toBeNull();
    expect(await dual.findOAuthAccountsByUserId(legacyId)).toHaveLength(1);
    expect(await dual.findOAuthAccountsByUserIds([legacyId])).toHaveLength(1);
    await shadowRunner.flush();

    expect(counts).toEqual({
      findUserById: 0,
      findUsersByIds: 0,
      findAttributionByUserId: 0,
      findOAuthAccountByProvider: 0,
      findOAuthAccountsByUserId: 0,
      findOAuthAccountsByUserIds: 0,
      resolveUserUuid: 0,
    });

    // Stage 4 with shadowSampleRate = 0 -> EXACTLY 1 PG primary call per read, ZERO extra PG lookups!
    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_pg_read",
      shadowSampleRate: 0,
    });

    expect((await dual.findUserById(pgUser.id))?.id).toBe(pgUser.id);
    expect(counts.findUserById).toBe(1);

    expect(await dual.findUsersByIds([pgUser.id])).toHaveLength(1);
    expect(counts.findUsersByIds).toBe(1);

    expect(await dual.findAttributionByUserId(pgUser.id)).not.toBeNull();
    expect(counts.findAttributionByUserId).toBe(1);
    expect(counts.findUserById).toBe(1); // unchanged — no eager pre-resolution!

    expect(
      await dual.findOAuthAccountByProvider("google", "g-perf-1"),
    ).not.toBeNull();
    expect(counts.findOAuthAccountByProvider).toBe(1);
    expect(counts.resolveUserUuid).toBe(0);

    expect(await dual.findOAuthAccountsByUserId(pgUser.id)).toHaveLength(1);
    expect(counts.findOAuthAccountsByUserId).toBe(1);
    expect(counts.findUserById).toBe(1); // unchanged

    expect(await dual.findOAuthAccountsByUserIds([pgUser.id])).toHaveLength(1);
    expect(counts.findOAuthAccountsByUserIds).toBe(1);
    expect(counts.findUsersByIds).toBe(1); // unchanged

    // Stage 3 & Stage 4 with shadowSampleRate = 1 -> shadow compare matches cleanly for legacy user!
    rngValue = 0.0;
    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 1,
    });
    await dual.findOAuthAccountByProvider("google", "g-perf-1");
    await dual.findOAuthAccountsByUserIds([legacyId]);
    await shadowRunner.flush();
    expect(shadowEvents.slice(-2).every(e => e.result === "match")).toBe(true);

    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_pg_read",
      shadowSampleRate: 1,
    });
    const prevFindUserCount = counts.findUserById;
    await dual.findUserById(pgUser.id);
    await dual.findOAuthAccountByProvider("google", "g-perf-1");
    await dual.findOAuthAccountsByUserIds([pgUser.id]);
    await shadowRunner.flush();
    // findUserById Stage 4 shadow reuses pgResult.legacyId -> still only +1 PG user lookup total!
    expect(counts.findUserById).toBe(prevFindUserCount + 1);
    expect(shadowEvents.slice(-3).every(e => e.result === "match")).toBe(true);
  });

  it("runs auth parity verification using only the injected db without calling getPgDb()", async () => {
    clearBackfillRegistryForTests();
    clearVerifierRegistryForTests();
    registerMigrationDomains({ force: true });

    const now = new Date("2026-11-26T09:00:00.000Z");
    await User.create({
      _id: "direct_db_user1",
      email: "directdb@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await OAuthAccount.create({
      _id: new mongoose.Types.ObjectId(newDualId(now.getTime()).oid),
      userId: "direct_db_user1",
      provider: "github",
      providerUserId: "gh-direct-db",
      email: "directdb@example.com",
      createdAt: now,
    });

    const backfill = await runBackfill({ domain: "auth", batchSize: 10, db });
    expect(backfill.status).toBe("completed");

    // Reset global test DB and clear POSTGRES_URL so any accidental getPgDb() call throws!
    resetPgTestDb();
    const prevPgUrl = process.env.POSTGRES_URL;
    delete process.env.POSTGRES_URL;
    try {
      const compositeReport = await runParityVerification({
        domain: "auth",
        batchSize: 10,
        db,
      });
      expect(compositeReport.ok).toBe(true);

      const tableReport = await runParityVerification({
        domain: "auth:oauth_accounts",
        batchSize: 10,
        db,
      });
      expect(tableReport.ok).toBe(true);
    } finally {
      if (prevPgUrl !== undefined) {
        process.env.POSTGRES_URL = prevPgUrl;
      }
    }
  });

  // ── 8. PR #1553 review regression tests ──────────────────────────────────

  it("queues sync-retry when Stage 2/3 PG secondary updateUser misses a row so stale backfill cannot restore an old password (#4717224061)", async () => {
    const captured: SecondaryWriteFailureContext[] = [];
    const router = new MigrationRouter({
      enablePubSub: false,
      onSecondaryFailure: async ctx => {
        captured.push(ctx);
      },
    });
    const mongoRepo = new MongoAuthRepository();
    const pgRepo = new PgAuthRepository({ getDb: () => db });
    const dual = new DualAuthRepository({
      mongo: mongoRepo,
      pg: pgRepo,
      router,
      getDb: () => db,
    });

    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_mongo_read",
    });

    const t0 = new Date("2026-11-26T10:00:00.000Z");
    const t1 = new Date("2026-11-26T10:05:00.000Z");

    // 1. User exists in Mongo ONLY (not yet backfilled into PG) with attacker-set old hash
    const staleMongoSnapshot = await mongoRepo.createUser({
      id: "pw_race_user_01",
      email: "race@example.com",
      hashedPassword: "$2b$10$old-attacker-password",
      emailVerified: false,
      createdAt: t0,
      updatedAt: t0,
    });
    expect(await pgRepo.findUserById("pw_race_user_01")).toBeNull();

    // 2. User completes OAuth takeover guard / password reset -> updates Mongo; PG row is missing
    const updated = await dual.updateUser("pw_race_user_01", {
      emailVerified: true,
      hashedPassword: null,
      updatedAt: t1,
    });
    expect(updated?.emailVerified).toBe(true);
    expect(updated?.hashedPassword).toBeUndefined();

    // 3. PG secondary threw on missing row so sync-retry was queued!
    expect(captured).toHaveLength(1);
    expect(captured[0].target).toBe("pg");
    expect(captured[0].operation).toBe("updateUser");

    // 4. Stale in-flight backfill batch lands old snapshot into PG
    await pgRepo.upsertUserWithGuard(staleMongoSnapshot, db);
    expect((await pgRepo.findUserById("pw_race_user_01"))?.hashedPassword).toBe(
      "$2b$10$old-attacker-password",
    );

    // 5. Sync-retry replays from Mongo and overwrites the stale PG snapshot via updated_at guard
    await replayAuthWriteToPg(
      {
        target: "pg",
        domain: captured[0].domain,
        operation: captured[0].operation,
        entityId: captured[0].entityId ?? "unknown",
        payload: captured[0].payload,
        failedAt: new Date().toISOString(),
        errorMessage: "PG user missing",
      },
      db,
    );
    const healedPg = await pgRepo.findUserById("pw_race_user_01");
    expect(healedPg?.emailVerified).toBe(true);
    expect(healedPg?.hashedPassword).toBeUndefined();

    // Updating a genuinely nonexistent user returns null without queueing a spurious retry
    expect(
      await dual.updateUser("does-not-exist-anywhere", { emailVerified: true }),
    ).toBeNull();
    expect(captured).toHaveLength(1);

    // Stage 4 reverse check: PG primary succeeds while Mongo row is missing -> queues Mongo retry
    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_pg_read",
    });
    const pgOnlyUser = await pgRepo.createUser({
      email: "pg-only-stage4@example.com",
      hashedPassword: "v1",
      emailVerified: true,
    });
    await dual.updateUser(pgOnlyUser.id, { hashedPassword: "v2" });
    expect(captured).toHaveLength(2);
    expect(captured[1].target).toBe("mongo");
    await replayAuthWriteToMongo(
      {
        target: "mongo",
        domain: captured[1].domain,
        operation: captured[1].operation,
        entityId: captured[1].entityId ?? "unknown",
        payload: captured[1].payload,
        failedAt: new Date().toISOString(),
        errorMessage: "Mongo user missing",
      },
      db,
    );
    expect((await mongoRepo.findUserById(pgOnlyUser.id))?.hashedPassword).toBe(
      "v2",
    );
  });

  it("tombstones Mongo-only codes deleted by email+type so backfill cannot resurrect them (#4717224459)", async () => {
    clearBackfillRegistryForTests();
    registerMigrationDomains({ force: true });

    const router = new MigrationRouter({ enablePubSub: false });
    const mongoRepo = new MongoAuthRepository();
    const pgRepo = new PgAuthRepository({ getDb: () => db });
    const dual = new DualAuthRepository({
      mongo: mongoRepo,
      pg: pgRepo,
      router,
      getDb: () => db,
    });

    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_mongo_read",
    });

    const future = new Date(Date.now() + 10 * 60_000);
    // Code V1 exists ONLY in Mongo (not yet backfilled to PG)
    const vMongoOnly = await mongoRepo.createEmailVerification({
      email: "tombstone-union@example.com",
      code: "111111",
      type: "password_reset",
      expiresAt: future,
    });
    // Code V2 exists ONLY in PG
    const vPgOnly = await pgRepo.createEmailVerification({
      email: "tombstone-union@example.com",
      code: "222222",
      type: "password_reset",
      expiresAt: future,
    });

    await dual.deleteEmailVerificationsByEmailAndType(
      "tombstone-union@example.com",
      "password_reset",
    );

    expect(
      await mongoRepo.findValidEmailVerification(
        "tombstone-union@example.com",
        "111111",
        "password_reset",
      ),
    ).toBeNull();
    expect(await pgRepo.findEmailVerificationById(vPgOnly.id, db)).toBeNull();

    // BOTH Mongo-only and PG-only deleted IDs must be tombstoned!
    const tombstones = (
      await db.select().from(pgSchema.migrationTombstones)
    ).filter(t => t.tableName === "email_verifications");
    expect(tombstones.map(t => t.entityId).sort()).toEqual(
      [vMongoOnly.id.toLowerCase(), vPgOnly.id.toLowerCase()].sort(),
    );

    // Re-insert V1 in Mongo to simulate an in-flight backfill snapshot that had already read V1
    await mongoRepo.createEmailVerification({
      id: vMongoOnly.id,
      email: "tombstone-union@example.com",
      code: "111111",
      type: "password_reset",
      expiresAt: future,
    });
    const backfill = await runBackfill({
      domain: "auth:email_verifications",
      batchSize: 10,
      db,
    });
    expect(backfill.rowsSkippedTombstone).toBe(1);
    expect(
      await pgRepo.findEmailVerificationById(vMongoOnly.id, db),
    ).toBeNull();
  });

  it("omits user email PII from deleteEmailVerificationsByEmailAndType retry payload and replays by captured IDs without deleting newer codes (#4717224866, #4717227780)", async () => {
    const captured: SecondaryWriteFailureContext[] = [];
    const router = new MigrationRouter({
      enablePubSub: false,
      onSecondaryFailure: async ctx => {
        captured.push(ctx);
      },
    });
    const mongoRepo = new MongoAuthRepository();
    const pgRepo = new PgAuthRepository({ getDb: () => db });
    const brokenPg = Object.create(pgRepo) as PgAuthRepository;
    brokenPg.deleteEmailVerificationsReturningIds = async () => {
      throw new Error("Simulated PG outage on delete");
    };

    const dualHealthy = new DualAuthRepository({
      mongo: mongoRepo,
      pg: pgRepo,
      router,
      getDb: () => db,
    });
    const dualBrokenPg = new DualAuthRepository({
      mongo: mongoRepo,
      pg: brokenPg,
      router,
      getDb: () => db,
    });

    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_mongo_read",
    });

    const piiEmail = "private-user-pii@example.com";
    const future = new Date(Date.now() + 15 * 60_000);

    // Seed old verification code in BOTH Mongo and PG
    const oldCode = await dualHealthy.createEmailVerification({
      email: piiEmail,
      code: "100001",
      type: "password_reset",
      expiresAt: future,
    });

    // t0: Delete succeeds in Mongo, fails in PG -> retry queued
    await dualBrokenPg.deleteEmailVerificationsByEmailAndType(
      piiEmail,
      "password_reset",
    );
    expect(captured).toHaveLength(1);
    expect(captured[0].target).toBe("pg");
    expect(captured[0].payload).toEqual({
      table: "email_verifications",
      verificationIds: [oldCode.id],
    });
    // Zero email PII in retry payload or serialized failure context!
    expect(JSON.stringify(captured[0])).not.toContain(piiEmail);

    // t1: User requests a NEW code Y -> written to both Mongo and PG
    const newCode = await dualHealthy.createEmailVerification({
      email: piiEmail,
      code: "200002",
      type: "password_reset",
      expiresAt: future,
    });

    // t2: Delayed sync-retry replays t0 delete -> MUST delete oldCode ONLY, NOT newCode!
    await replayAuthWriteToPg(
      {
        target: "pg",
        domain: captured[0].domain,
        operation: captured[0].operation,
        entityId: captured[0].entityId ?? "unknown",
        payload: captured[0].payload,
        failedAt: new Date().toISOString(),
        errorMessage: "Simulated PG outage on delete",
      },
      db,
    );

    expect(await pgRepo.findEmailVerificationById(oldCode.id, db)).toBeNull();
    expect(
      await pgRepo.findValidEmailVerification(
        piiEmail,
        "200002",
        "password_reset",
      ),
    ).toMatchObject({ id: newCode.id, code: "200002" });

    // Only oldCode is tombstoned — newCode MUST NOT be tombstoned!
    const tombstones = (
      await db.select().from(pgSchema.migrationTombstones)
    ).filter(t => t.tableName === "email_verifications");
    expect(tombstones.map(t => t.entityId)).toEqual([oldCode.id.toLowerCase()]);

    // Stage 4 reverse direction: Mongo secondary fails -> payload has ONLY IDs, replay keeps newer Mongo code
    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_pg_read",
    });
    const brokenMongo = Object.create(mongoRepo) as MongoAuthRepository;
    brokenMongo.deleteEmailVerificationsByIds = async () => {
      throw new Error("Simulated Mongo outage on delete");
    };
    const dualBrokenMongo = new DualAuthRepository({
      mongo: brokenMongo,
      pg: pgRepo,
      router,
      getDb: () => db,
    });
    await dualBrokenMongo.deleteEmailVerificationsByEmailAndType(
      piiEmail,
      "password_reset",
    );
    expect(captured).toHaveLength(2);
    expect(captured[1].target).toBe("mongo");
    expect(captured[1].payload).toEqual({
      table: "email_verifications",
      verificationIds: [newCode.id],
    });
    expect(JSON.stringify(captured[1])).not.toContain(piiEmail);

    const newerStage4Code = await dualHealthy.createEmailVerification({
      email: piiEmail,
      code: "300003",
      type: "password_reset",
      expiresAt: future,
    });
    await replayAuthWriteToMongo(
      {
        target: "mongo",
        domain: captured[1].domain,
        operation: captured[1].operation,
        entityId: captured[1].entityId ?? "unknown",
        payload: captured[1].payload,
        failedAt: new Date().toISOString(),
        errorMessage: "Simulated Mongo outage on delete",
      },
      db,
    );
    expect(
      await mongoRepo.findValidEmailVerification(
        piiEmail,
        "200002",
        "password_reset",
      ),
    ).toBeNull();
    expect(
      await mongoRepo.findValidEmailVerification(
        piiEmail,
        "300003",
        "password_reset",
      ),
    ).toMatchObject({ id: newerStage4Code.id, code: "300003" });
  });

  it("revokes matching Mongo sessions best-effort during Stage 4 deleteSession and deleteUserSessions so rollback never resurrects them (#4717226541)", async () => {
    const router = new MigrationRouter({ enablePubSub: false });
    const mongoRepo = new MongoAuthRepository();
    const pgRepo = new PgAuthRepository({ getDb: () => db });
    const dual = new DualAuthRepository({
      mongo: mongoRepo,
      pg: pgRepo,
      router,
      getDb: () => db,
    });

    // Stage 3: create both a legacy Lucia user and a UUIDv7 user + Mongo sessions
    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 1,
    });
    const legacyUser = await dual.createUser({
      id: "sess_rollback_u1",
      email: "rollback-legacy@example.com",
      emailVerified: true,
    });
    const newUser = await dual.createUser({
      email: "rollback-v7@example.com",
      emailVerified: true,
    });
    const legacyPgUser = await pgRepo.findUserById(legacyUser.id);
    if (!legacyPgUser) throw new Error("Expected legacyPgUser");

    const future = new Date(Date.now() + 600_000);
    const stolenLegacyMongoSession = makeSessionId();
    const loggedOutMongoSession = makeSessionId();
    await dual.createSession({
      id: stolenLegacyMongoSession,
      userId: legacyUser.id, // stored under legacy Mongo `_id`
      expiresAt: future,
    });
    await dual.createSession({
      id: loggedOutMongoSession,
      userId: newUser.id,
      expiresAt: future,
    });

    // Promote to Stage 4: create PG sessions and then revoke via logout & password reset
    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_pg_read",
    });
    const stage4PgSession = makeSessionId();
    await dual.createSession({
      id: stage4PgSession,
      userId: legacyPgUser.id,
      expiresAt: future,
    });

    // Logout on specific session token + password-reset deleteUserSessions with PG UUID
    await dual.deleteSession(loggedOutMongoSession);
    await dual.deleteUserSessions(legacyPgUser.id);

    expect(await pgRepo.findSessionById(stage4PgSession)).toBeNull();

    // Roll back Stage 4 -> Stage 3: revoked sessions MUST NOT come back!
    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_shadow_compare",
    });
    expect(await dual.findSessionById(stolenLegacyMongoSession)).toBeNull();
    expect(await dual.findSessionById(loggedOutMongoSession)).toBeNull();

    // Best-effort resilience: Mongo failure during Stage 4 delete does NOT fail PG revocation
    await router.setDomainState({
      domain: "auth",
      mode: "dual_write_pg_read",
    });
    const brokenMongo = Object.create(mongoRepo) as MongoAuthRepository;
    brokenMongo.deleteSession = async () => {
      throw new Error("Simulated Mongo outage");
    };
    brokenMongo.deleteUserSessions = async () => {
      throw new Error("Simulated Mongo outage");
    };
    const dualBrokenMongo = new DualAuthRepository({
      mongo: brokenMongo,
      pg: pgRepo,
      router,
      getDb: () => db,
    });
    const sResilient1 = makeSessionId();
    const sResilient2 = makeSessionId();
    await pgRepo.createSession({
      id: sResilient1,
      userId: legacyPgUser.id,
      expiresAt: future,
    });
    await pgRepo.createSession({
      id: sResilient2,
      userId: legacyPgUser.id,
      expiresAt: future,
    });
    await expect(
      dualBrokenMongo.deleteSession(sResilient1),
    ).resolves.toBeUndefined();
    await expect(
      dualBrokenMongo.deleteUserSessions(legacyPgUser.id),
    ).resolves.toBeUndefined();
    expect(await pgRepo.findSessionById(sResilient1)).toBeNull();
    expect(await pgRepo.findSessionById(sResilient2)).toBeNull();

    // Stage 5 (`pg_only`) never calls Mongo on session deletes
    await router.setDomainState({ domain: "auth", mode: "pg_only" });
    let mongoCalled = false;
    const spyMongo = Object.create(mongoRepo) as MongoAuthRepository;
    spyMongo.deleteSession = async () => {
      mongoCalled = true;
    };
    spyMongo.deleteUserSessions = async () => {
      mongoCalled = true;
    };
    const dualPgOnly = new DualAuthRepository({
      mongo: spyMongo,
      pg: pgRepo,
      router,
      getDb: () => db,
    });
    await dualPgOnly.deleteSession(makeSessionId());
    await dualPgOnly.deleteUserSessions(legacyPgUser.id);
    expect(mongoCalled).toBe(false);
  });

  it("excludes expired email_verifications and desktop_auth_codes from parity verification while still flagging unexpired extra PG rows (#4717226840)", async () => {
    clearBackfillRegistryForTests();
    clearVerifierRegistryForTests();
    registerMigrationDomains({ force: true });

    const now = new Date();
    const future = new Date(now.getTime() + 10 * 60_000);
    const expired = new Date(now.getTime() - 10 * 60_000);

    const mongoRepo = new MongoAuthRepository();
    const pgRepo = new PgAuthRepository({ getDb: () => db });

    await mongoRepo.createUser({
      id: "ttl_verify_u001",
      email: "ttlverify@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    const pgUser = await pgRepo.createUser({
      id: "ttl_verify_u001",
      email: "ttlverify@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });

    // Active code in BOTH Mongo and PG
    const evActiveId = randomUUID();
    await mongoRepo.createEmailVerification({
      id: evActiveId,
      email: "ttlverify@example.com",
      code: "123456",
      type: "registration",
      expiresAt: future,
      createdAt: now,
    });
    await pgRepo.createEmailVerification({
      id: evActiveId,
      email: "ttlverify@example.com",
      code: "123456",
      type: "registration",
      expiresAt: future,
      createdAt: now,
    });

    const dacActiveId = sha256Base64url("active-desktop-code");
    await mongoRepo.createDesktopAuthCode({
      id: dacActiveId,
      userId: "ttl_verify_u001",
      challenge: sha256Base64url("active-challenge"),
      expiresAt: future,
      createdAt: now,
    });
    await pgRepo.createDesktopAuthCode({
      id: dacActiveId,
      userId: pgUser.id,
      challenge: sha256Base64url("active-challenge"),
      expiresAt: future,
      createdAt: now,
    });

    // Expired rows ONLY in PG (Mongo's 60s TTL already deleted them while PG hourly reaper hasn't run yet)
    await pgRepo.createEmailVerification({
      id: randomUUID(),
      email: "ttlverify@example.com",
      code: "000001",
      type: "password_reset",
      expiresAt: expired,
      createdAt: expired,
    });
    await pgRepo.createDesktopAuthCode({
      id: sha256Base64url("expired-pg-only-code"),
      userId: pgUser.id,
      challenge: sha256Base64url("expired-challenge"),
      expiresAt: expired,
      createdAt: expired,
    });

    // Expired row ONLY in Mongo (not in PG)
    await mongoRepo.createEmailVerification({
      id: randomUUID(),
      email: "ttlverify@example.com",
      code: "000002",
      type: "registration",
      expiresAt: expired,
      createdAt: expired,
    });

    // Composite and per-table verifiers MUST all pass cleanly!
    for (const domain of [
      "auth",
      "auth:email_verifications",
      "auth:desktop_auth_codes",
    ] as const) {
      const report = await runParityVerification({
        domain,
        batchSize: 10,
        db,
      });
      expect(report.ok).toBe(true);
      expect(report.extraInPg).toBe(0);
      expect(report.missingInPg).toBe(0);
      expect(report.mismatched).toBe(0);
    }

    // An UNEXPIRED extra PG row MUST still be detected as extra_in_pg
    await pgRepo.createEmailVerification({
      id: randomUUID(),
      email: "ttlverify@example.com",
      code: "999999",
      type: "registration",
      expiresAt: future,
      createdAt: now,
    });
    const extraReport = await runParityVerification({
      domain: "auth:email_verifications",
      batchSize: 10,
      db,
    });
    expect(extraReport.ok).toBe(false);
    expect(extraReport.extraInPg).toBe(1);
  });

  it("throws from child sync-retry replays when parent user is not in PG yet so Inngest retries with backoff (#4717227221)", async () => {
    const mongoRepo = new MongoAuthRepository();
    const pgRepo = new PgAuthRepository({ getDb: () => db });

    const now = new Date("2026-11-26T12:00:00.000Z");
    const userId = "delayed_parent1";
    await mongoRepo.createUser({
      id: userId,
      email: "delayed-parent@example.com",
      emailVerified: true,
      createdAt: now,
      updatedAt: now,
    });
    await mongoRepo.upsertAttributionOnce({
      userId,
      signupMethod: "google",
      gclid: "G-DELAYED",
      firstTouch: {},
      lastTouch: {},
      capturedAt: now,
    });
    const oauth = await mongoRepo.createOAuthAccount({
      userId,
      provider: "google",
      providerUserId: "g-delayed-parent",
      email: "delayed-parent@example.com",
      createdAt: now,
    });
    const dacId = sha256Base64url("delayed-dac");
    await mongoRepo.createDesktopAuthCode({
      id: dacId,
      userId,
      challenge: sha256Base64url("delayed-challenge"),
      expiresAt: new Date(Date.now() + 60_000),
      createdAt: now,
    });

    const mkEvent = (
      operation: string,
      entityId: string,
      payload: Record<string, unknown>,
    ): SyncRetryEventData => ({
      target: "pg",
      domain: "auth",
      operation,
      entityId,
      payload,
      failedAt: now.toISOString(),
      errorMessage: "FK violation before user landed",
    });

    // Before parent user lands in PG, ALL THREE child replays MUST throw!
    await expect(
      replayAuthWriteToPg(
        mkEvent("upsertAttributionOnce", userId, {
          table: "user_attributions",
          userId,
        }),
        db,
      ),
    ).rejects.toThrow(/not yet in Postgres/i);
    await expect(
      replayAuthWriteToPg(
        mkEvent("createOAuthAccount", oauth.id, {
          table: "oauth_accounts",
          oauthAccountId: oauth.id,
        }),
        db,
      ),
    ).rejects.toThrow(/not yet in Postgres/i);
    await expect(
      replayAuthWriteToPg(
        mkEvent("createDesktopAuthCode", dacId, {
          table: "desktop_auth_codes",
          codeHash: dacId,
        }),
        db,
      ),
    ).rejects.toThrow(/not yet in Postgres/i);

    // Once parent user replay lands in PG, all three child replays succeed cleanly!
    await replayAuthWriteToPg(
      mkEvent("createUser", userId, { table: "users", userId }),
      db,
    );
    await replayAuthWriteToPg(
      mkEvent("upsertAttributionOnce", userId, {
        table: "user_attributions",
        userId,
      }),
      db,
    );
    await replayAuthWriteToPg(
      mkEvent("createOAuthAccount", oauth.id, {
        table: "oauth_accounts",
        oauthAccountId: oauth.id,
      }),
      db,
    );
    await replayAuthWriteToPg(
      mkEvent("createDesktopAuthCode", dacId, {
        table: "desktop_auth_codes",
        codeHash: dacId,
      }),
      db,
    );

    expect((await pgRepo.findAttributionByUserId(userId))?.gclid).toBe(
      "G-DELAYED",
    );
    expect(
      await pgRepo.findOAuthAccountByProvider("google", "g-delayed-parent"),
    ).not.toBeNull();
    expect(await pgRepo.findDesktopAuthCodeById(dacId, db)).not.toBeNull();
  });

  it("quarantines malformed legacy users and email_verifications with missing or non-string email instead of crashing backfill (#4717227508)", async () => {
    clearBackfillRegistryForTests();
    registerMigrationDomains({ force: true });

    const now = new Date("2026-11-26T12:00:00.000Z");
    const future = new Date(Date.now() + 300_000);

    // Insert malformed legacy docs directly via raw driver (bypassing Mongoose validation)
    await User.collection.insertMany([
      {
        _id: "u_bad_01_missing" as unknown as mongoose.Types.ObjectId,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        _id: "u_bad_02_nonstring" as unknown as mongoose.Types.ObjectId,
        email: 12345 as unknown as string,
        emailVerified: false,
        createdAt: now,
        updatedAt: now,
      },
      {
        _id: "u_good_03_valid" as unknown as mongoose.Types.ObjectId,
        email: "valid-after-bad@example.com",
        emailVerified: true,
        createdAt: now,
        updatedAt: now,
      },
    ]);

    const goodEvId = randomUUID();
    await EmailVerification.collection.insertMany([
      {
        _id: "ev_bad_01_missing" as unknown as mongoose.Types.ObjectId,
        code: "111111",
        type: "registration",
        expiresAt: future,
        createdAt: now,
      },
      {
        _id: "ev_bad_02_nonstring" as unknown as mongoose.Types.ObjectId,
        email: { broken: true } as unknown as string,
        code: "222222",
        type: "registration",
        expiresAt: future,
        createdAt: now,
      },
      {
        _id: goodEvId as unknown as mongoose.Types.ObjectId,
        email: "valid-after-bad@example.com",
        code: "333333",
        type: "registration",
        expiresAt: future,
        createdAt: now,
      },
    ]);

    const summary = await runBackfill({
      domain: "auth",
      batchSize: 2,
      db,
    });
    expect(summary.status).toBe("completed");
    expect(summary.rowsQuarantined).toBe(4);

    const quarantined = await db.select().from(pgSchema.migrationQuarantine);
    expect(quarantined).toHaveLength(4);
    expect(
      quarantined
        .filter(q => q.reason === "invalid_user_missing_email")
        .map(q => q.collectionName),
    ).toEqual(["users", "users"]);
    expect(
      quarantined
        .filter(q => q.reason === "invalid_email_verification")
        .map(q => q.collectionName),
    ).toEqual(["emailverifications", "emailverifications"]);

    // Valid records right after the malformed ones were still backfilled cleanly
    const pgRepo = new PgAuthRepository({ getDb: () => db });
    expect(await pgRepo.findUserById("u_good_03_valid")).toMatchObject({
      email: "valid-after-bad@example.com",
    });
    expect(await pgRepo.findEmailVerificationById(goodEvId, db)).toMatchObject({
      code: "333333",
    });
  });
});

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

  // ── 4. Secondary failure isolation + zero session retry payloads ─────────

  // ── 5. FK-ordered Backfill (5 tables, NO sessions), Verifier --repair, TTL Reaper ─

  // ── 6. Verifier #28 regression tests ─────────────────────────────────────

  // ── 7. Verifier #41 regression tests (critical-path read overhead & injected DB) ─

  // ── 8. PR #1553 review regression tests ──────────────────────────────────
});

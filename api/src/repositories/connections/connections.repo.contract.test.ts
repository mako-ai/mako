/**
 * Phase 2A-1 (`connections` domain — 5 tables) repository contract, explicit
 * encryption, byte-identical dual-write ciphertext, 5-stage workspace-scoped
 * dual-run, `live_readers` NULL vs `[]` fidelity, atomic `keyRequest` claim &
 * CAS rollback, `user:<uuid>` principal rewriting, SQL `listRecentWriters` &
 * `listWorkspaceIdsWithDueRetries` parity, FK-ordered backfill, parity verifier
 * (`--repair`), bidirectional sync-retry, and 90-day TTL reaper test suite.
 */
import { createHash, randomBytes } from "node:crypto";
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
import { ConnectionAccessEvent } from "../../access/connection-access-event";
import { ConnectionWriteEvent } from "../../access/connection-write-event";
import {
  resetPgTestDb,
  setPgTestDb,
  type MakoPgDb,
} from "../../database/pg/client";
import {
  generateUuidv7,
  legacyUserIdToUuidv7,
  newDualId,
  objectIdToUuid,
  toWireId,
} from "../../database/pg/id-codec";
import { runPgliteMigrations } from "../../database/pg/migrate";
import * as pgSchema from "../../database/pg/schema";
import { createTestPglite } from "../../database/pg/test-pglite";
import {
  ConnectorDefinition,
  DatabaseConnection,
  SourceConnection,
} from "../../database/workspace-schema";
import {
  clearBackfillRegistryForTests,
  listBackfillDomains,
  runBackfill,
} from "../../migration/backfill";
import { registerMigrationDomains } from "../../migration/domains";
import {
  replayConnectionsWriteToMongo,
  replayConnectionsWriteToPg,
} from "../../migration/domains/connections.backfill";
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
import { encryptString, isEncryptedValue } from "../../services/crypto.service";
import { decryptConnectionObject, encryptConnectionObject } from "./crypto";
import { DualConnectionsRepository } from "./dual.repo";
import { MongoConnectionsRepository } from "./mongo.repo";
import { PgConnectionsRepository } from "./pg.repo";
import type { ConnectionsRepository } from "./types";

const TEST_ENCRYPTION_KEY = randomBytes(32).toString("hex");

function sha256Hex(value: string): string {
  return createHash("sha256").update(value).digest("hex");
}

describe("Phase 2A-1 ConnectionsRepository contract & migration lifecycle", () => {
  let mongo: MongoMemoryServer;
  let pg: PGlite;
  let db: MakoPgDb;
  let prevEncryptionKey: string | undefined;

  let wsAOid: string;
  let wsBOid: string;
  let legacyUserId: string;
  let legacyUserUuid: string;
  let nativeUserUuid: string;

  beforeAll(async () => {
    prevEncryptionKey = process.env.ENCRYPTION_KEY;
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;

    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());
    await Promise.all([
      DatabaseConnection.syncIndexes(),
      SourceConnection.syncIndexes(),
      ConnectorDefinition.syncIndexes(),
      ConnectionAccessEvent.syncIndexes(),
      ConnectionWriteEvent.syncIndexes(),
    ]);

    pg = createTestPglite();
    await runPgliteMigrations(pg);
    db = drizzle(pg, { schema: pgSchema }) as unknown as MakoPgDb;
  });

  async function seedPgFixtures(): Promise<void> {
    const t0 = new Date("2026-11-01T10:00:00.000Z");
    legacyUserId = "conn_legacy_user_1";
    legacyUserUuid = legacyUserIdToUuidv7(legacyUserId, t0);
    nativeUserUuid = generateUuidv7(t0.getTime() + 1000);

    await db.insert(pgSchema.users).values([
      {
        id: legacyUserUuid,
        legacyId: legacyUserId,
        email: "legacy-conn@example.com",
        emailVerified: true,
        createdAt: t0,
        updatedAt: t0,
      },
      {
        id: nativeUserUuid,
        legacyId: nativeUserUuid,
        email: "native-conn@example.com",
        emailVerified: true,
        createdAt: t0,
        updatedAt: t0,
      },
    ]);

    const wsADual = newDualId(t0.getTime());
    const wsBDual = newDualId(t0.getTime() + 5000);
    wsAOid = wsADual.oid;
    wsBOid = wsBDual.oid;

    await db.insert(pgSchema.workspaces).values([
      {
        id: wsADual.uuid,
        name: "RealAdvisor Test",
        slug: "realadvisor-test",
        createdBy: legacyUserUuid,
        createdAt: t0,
        updatedAt: t0,
      },
      {
        id: wsBDual.uuid,
        name: "Control Workspace",
        slug: "control-workspace",
        createdBy: nativeUserUuid,
        createdAt: t0,
        updatedAt: t0,
      },
    ]);
  }

  async function cleanAllStores(): Promise<void> {
    await Promise.all([
      DatabaseConnection.collection.deleteMany({}),
      SourceConnection.collection.deleteMany({}),
      ConnectorDefinition.collection.deleteMany({}),
      ConnectionAccessEvent.collection.deleteMany({}),
      ConnectionWriteEvent.collection.deleteMany({}),
    ]);
    await pg.exec(`
      DELETE FROM connection_write_events;
      DELETE FROM connection_access_events;
      DELETE FROM connector_definitions;
      DELETE FROM source_connections;
      DELETE FROM database_connections;
      DELETE FROM workspaces;
      DELETE FROM users;
      DELETE FROM migration_domain_state;
      DELETE FROM migration_backfill_jobs;
      DELETE FROM migration_tombstones;
      DELETE FROM migration_quarantine;
    `);
  }

  beforeEach(async () => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    setPgTestDb(db);
    await cleanAllStores();
    await seedPgFixtures();
  });

  afterEach(() => {
    process.env.ENCRYPTION_KEY = TEST_ENCRYPTION_KEY;
    resetPgTestDb();
  });

  afterAll(async () => {
    if (prevEncryptionKey === undefined) {
      delete process.env.ENCRYPTION_KEY;
    } else {
      process.env.ENCRYPTION_KEY = prevEncryptionKey;
    }
    await mongoose.disconnect();
    await mongo.stop();
    await pg.close();
  });

  // ── 1. Explicit repo-layer encryption (crypto.ts) ───────────────────────

  describe("explicit repo-layer encryption (crypto.ts)", () => {
    it("recursively encrypts nested objects & arrays, is idempotent, handles legacy JSON strings, and fails CLOSED without ENCRYPTION_KEY", () => {
      const plain = {
        host: "db.internal",
        port: 5432,
        ssl: true,
        password: "super-secret-password!",
        empty: "",
        tags: ["primary", "eu-west"],
        sshTunnel: {
          enabled: true,
          host: "bastion.internal",
          port: 22,
          privateKey: "-----BEGIN OPENSSH PRIVATE KEY-----\nabc\n-----END-----",
          passphrase: "ssh-passphrase",
        },
        nestedList: [{ token: "tok-1" }, { token: "tok-2", count: 2 }],
      };

      const encrypted = encryptConnectionObject(plain);
      expect(isEncryptedValue(String(encrypted.host))).toBe(true);
      expect(isEncryptedValue(String(encrypted.password))).toBe(true);
      expect(encrypted.port).toBe(5432);
      expect(encrypted.ssl).toBe(true);
      expect(encrypted.empty).toBe("");
      expect(Array.isArray(encrypted.tags)).toBe(true);
      expect((encrypted.tags as string[]).every(t => isEncryptedValue(t))).toBe(
        true,
      );
      const ssh = encrypted.sshTunnel as Record<string, unknown>;
      expect(ssh.enabled).toBe(true);
      expect(ssh.port).toBe(22);
      expect(isEncryptedValue(String(ssh.privateKey))).toBe(true);
      expect(isEncryptedValue(String(ssh.passphrase))).toBe(true);

      // Idempotent re-encryption does NOT double-encrypt existing ciphertexts
      const encryptedAgain = encryptConnectionObject(encrypted);
      expect(encryptedAgain).toEqual(encrypted);

      // Decryption round-trips identically without mutating input
      const decrypted = decryptConnectionObject(encrypted);
      expect(decrypted).toEqual(plain);

      // Legacy JSON-stringified connection payload decrypts cleanly
      const legacyJson = JSON.stringify(encrypted);
      expect(decryptConnectionObject(legacyJson)).toEqual(plain);

      // Doubly-quoted string guard avoids infinite recursion
      expect(decryptConnectionObject('"already-a-string"')).toEqual({});

      // Fails CLOSED when ENCRYPTION_KEY is missing
      const savedKey = process.env.ENCRYPTION_KEY;
      delete process.env.ENCRYPTION_KEY;
      try {
        expect(() =>
          encryptConnectionObject({ host: "db.local", password: "secret" }),
        ).toThrow(/ENCRYPTION_KEY/);
      } finally {
        process.env.ENCRYPTION_KEY = savedKey;
      }
    });
  });

  // ── 2. Shared repository behavioral contract (Mongo AND Postgres) ────────

  const implementations: Array<{
    name: string;
    isPg: boolean;
    create: () => ConnectionsRepository;
  }> = [
    {
      name: "MongoConnectionsRepository",
      isPg: false,
      create: () => new MongoConnectionsRepository(),
    },
    {
      name: "PgConnectionsRepository",
      isPg: true,
      create: () => new PgConnectionsRepository({ getDb: () => db }),
    },
  ];

  for (const impl of implementations) {
    describe(`ConnectionsRepository contract: ${impl.name}`, () => {
      it("manages database_connections CRUD, metadata-only summary queries, writers NULL vs [], and workspace isolation", async () => {
        const repo = impl.create();
        const t1 = new Date("2026-11-10T10:00:00.000Z");
        const t2 = new Date("2026-11-10T11:00:00.000Z");

        const db1 = await repo.createDatabaseConnection({
          workspaceId: wsAOid,
          name: "  Primary Analytics  ",
          type: "postgresql",
          connection: {
            host: "pg.internal",
            port: 5432,
            database: "analytics",
            password: "db1-password",
            sshTunnel: {
              enabled: true,
              host: "bastion.local",
              port: 22,
              privateKey: "ssh-secret-key",
            },
          },
          allowAgentWrites: true,
          writers: [
            {
              principal: `user:${nativeUserUuid}`,
              where: "public.*",
              addedBy: nativeUserUuid,
              addedAt: t1,
            },
          ],
          createdBy: nativeUserUuid,
          createdAt: t1,
        });

        expect(db1.id).toMatch(/^[0-9a-f]{24}$/);
        expect(db1._id).toBe(db1.id);
        expect(db1.name).toBe("Primary Analytics");
        expect(db1.connection.password).toBe("db1-password");
        expect(db1.connection.sshTunnel?.privateKey).toBe("ssh-secret-key");
        expect(db1.allowAgentWrites).toBe(true);
        expect(db1.writers).toHaveLength(1);
        expect(db1.writers?.[0].principal).toBe(`user:${nativeUserUuid}`);

        const dbDemo = await repo.createDatabaseConnection({
          workspaceId: wsAOid,
          name: "Demo DB",
          type: "sqlite",
          connection: { database: "/tmp/demo.db" },
          isDemo: true,
          createdBy: nativeUserUuid,
          createdAt: t2,
        });
        expect(dbDemo.writers).toBeUndefined();
        expect(dbDemo.isDemo).toBe(true);

        // Listing ordered newest-first + metadata projection skips connection payload
        const all = await repo.listDatabaseConnections(wsAOid);
        expect(all.map(c => c.id)).toEqual([dbDemo.id, db1.id]);

        const meta = await repo.listDatabaseConnectionMetadata(wsAOid);
        expect(meta.map(c => c.id)).toEqual([dbDemo.id, db1.id]);
        expect("connection" in meta[0]).toBe(false);

        const summary = await repo.findDatabaseConnectionSummary(
          db1.id,
          wsAOid,
        );
        expect(summary?.name).toBe("Primary Analytics");
        expect(summary && "connection" in summary).toBe(false);

        // Cross-workspace isolation
        expect(
          await repo.findDatabaseConnectionById(db1.id, wsBOid),
        ).toBeNull();
        expect(
          await repo.findDatabaseConnectionSummary(db1.id, wsBOid),
        ).toBeNull();

        // Batch lookups, by name, demo, count
        expect(
          (await repo.findDatabaseConnectionsByIds([db1.id, dbDemo.id], wsAOid))
            .map(c => c.id)
            .sort(),
        ).toEqual([db1.id, dbDemo.id].sort());
        expect(
          (
            await repo.findDatabaseConnectionSummariesByIds(
              [db1.id, dbDemo.id],
              wsAOid,
            )
          ).every(s => !("connection" in s)),
        ).toBe(true);
        expect(
          (await repo.findDatabaseConnectionByName(wsAOid, "Primary Analytics"))
            ?.id,
        ).toBe(db1.id);
        expect((await repo.findDemoDatabaseConnection(wsAOid))?.id).toBe(
          dbDemo.id,
        );
        expect(await repo.countDatabaseConnections(wsAOid)).toBe(2);
        expect(await repo.countDatabaseConnections(wsBOid)).toBe(0);

        // Update: writers [] vs null (undefined), connection replacement, touchLastConnected
        const emptyWriters = await repo.updateDatabaseConnection(
          db1.id,
          wsAOid,
          {
            name: "Analytics Renamed",
            connection: { host: "pg2.internal", password: "rotated-password" },
            writers: [],
          },
        );
        expect(emptyWriters?.name).toBe("Analytics Renamed");
        expect(emptyWriters?.connection.password).toBe("rotated-password");
        expect(emptyWriters?.writers).toEqual([]);

        const clearedWriters = await repo.updateDatabaseConnection(
          db1.id,
          wsAOid,
          { writers: null },
        );
        expect(clearedWriters?.writers).toBeUndefined();

        const touchedAt = new Date("2026-11-11T09:30:00.000Z");
        await repo.touchDatabaseConnectionLastConnected(
          db1.id,
          wsAOid,
          touchedAt,
        );
        expect(
          (await repo.findDatabaseConnectionSummary(db1.id, wsAOid))
            ?.lastConnectedAt,
        ).toEqual(touchedAt);

        // Delete enforces workspace scope
        expect(await repo.deleteDatabaseConnection(db1.id, wsBOid)).toBe(false);
        expect(await repo.deleteDatabaseConnection(db1.id, wsAOid)).toBe(true);
        expect(
          await repo.findDatabaseConnectionById(db1.id, wsAOid),
        ).toBeNull();
        expect(await repo.countDatabaseConnections(wsAOid)).toBe(1);
      });

      it("manages source_connections CRUD, live_readers NULL vs [] fidelity, ambiguous names, and atomic keyRequest claim + CAS rollback", async () => {
        const repo = impl.create();
        const t1 = new Date("2026-11-10T10:00:00.000Z");
        const targetDbId = newDualId(t1.getTime()).oid;

        const tokenHash = sha256Hex("one-time-secret-token");
        const keyRequest = {
          tokenHash,
          expiresAt: new Date(Date.now() + 600_000),
          fields: ["api_key", "webhook_secret"],
          requestedBy: nativeUserUuid,
          createdAt: t1,
        };

        // Connection 1: liveReads = true, liveReaders = undefined (everyone reads live)
        const srcEveryone = await repo.createSourceConnection({
          workspaceId: wsAOid,
          name: "Stripe Prod",
          type: "stripe",
          description: "Billing source",
          config: { base_url: "https://api.stripe.com" },
          settings: { sync_batch_size: 250, rate_limit_delay_ms: 100 },
          targetDatabases: [targetDbId],
          liveReads: true,
          managers: [nativeUserUuid],
          createdBy: nativeUserUuid,
          isActive: false,
          keyRequest,
          createdAt: t1,
        });
        expect(srcEveryone.liveReads).toBe(true);
        expect(srcEveryone.liveReaders).toBeUndefined();
        expect(srcEveryone.targetDatabases).toEqual([targetDbId]);
        expect(srcEveryone.managers).toEqual([nativeUserUuid]);
        expect(srcEveryone.keyRequest?.tokenHash).toBe(tokenHash);

        // Connection 2: liveReads = true, liveReaders = [] (writers ONLY — NOT undefined!)
        const srcWritersOnly = await repo.createSourceConnection({
          workspaceId: wsAOid,
          name: "HubSpot",
          type: "hubspot",
          config: { api_key: encryptString("hs-secret") },
          settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
          liveReads: true,
          liveReaders: [],
          createdBy: nativeUserUuid,
          isActive: true,
          createdAt: new Date(t1.getTime() + 1000),
        });
        expect(srcWritersOnly.liveReaders).toEqual([]);

        // Duplicate name in same workspace -> ambiguous
        await repo.createSourceConnection({
          workspaceId: wsAOid,
          name: "HubSpot",
          type: "hubspot",
          config: {},
          settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
          createdBy: nativeUserUuid,
          isActive: true,
          createdAt: new Date(t1.getTime() + 2000),
        });

        expect(
          await repo.findSourceConnectionByIdOrName(wsAOid, srcEveryone.id),
        ).toMatchObject({ connection: { id: srcEveryone.id } });
        expect(
          await repo.findSourceConnectionByIdOrName(wsAOid, "Stripe Prod"),
        ).toMatchObject({ connection: { id: srcEveryone.id } });
        expect(
          await repo.findSourceConnectionByIdOrName(wsAOid, "HubSpot"),
        ).toEqual({ connection: null, ambiguous: true });

        // Filters & projections
        expect(
          await repo.listSourceConnections(wsAOid, { type: "stripe" }),
        ).toHaveLength(1);
        expect(
          await repo.listSourceConnections(wsAOid, { isActive: true }),
        ).toHaveLength(2);
        expect(
          await repo.listActiveSourceConnections({
            workspaceId: wsAOid,
            type: "hubspot",
          }),
        ).toHaveLength(2);
        expect(
          await repo.listSourceConnectionIdNames({ isActive: true }),
        ).toHaveLength(2);
        expect(
          (await repo.findSourceConnectionByKeyTokenHash(wsAOid, tokenHash))
            ?.id,
        ).toBe(srcEveryone.id);

        // Toggle liveReaders: undefined -> [] -> null (restores undefined!)
        const restricted = await repo.updateSourceConnection(
          srcEveryone.id,
          wsAOid,
          { liveReaders: [] },
        );
        expect(restricted?.liveReaders).toEqual([]);
        const restoredEveryone = await repo.updateSourceConnection(
          srcEveryone.id,
          wsAOid,
          { liveReaders: null, managers: null },
        );
        expect(restoredEveryone?.liveReaders).toBeUndefined();
        expect(restoredEveryone?.managers).toBeUndefined();

        // Atomic keyRequest claim: wrong token & expired clock rejected
        const encryptedFields = {
          api_key: encryptString("sk_live_claimed_123"),
          webhook_secret: encryptString("whsec_claimed_456"),
        };
        expect(
          await repo.claimSourceConnectionKeyRequest({
            id: srcEveryone.id,
            workspaceId: wsAOid,
            tokenHash: sha256Hex("wrong-token"),
            encryptedFields,
          }),
        ).toBe(false);
        expect(
          await repo.claimSourceConnectionKeyRequest({
            id: srcEveryone.id,
            workspaceId: wsAOid,
            tokenHash,
            encryptedFields,
            now: new Date(keyRequest.expiresAt.getTime() + 1000),
          }),
        ).toBe(false);

        // Concurrent double-claim: exactly ONE wins!
        const claimResults = await Promise.all([
          repo.claimSourceConnectionKeyRequest({
            id: srcEveryone.id,
            workspaceId: wsAOid,
            tokenHash,
            encryptedFields,
          }),
          repo.claimSourceConnectionKeyRequest({
            id: srcEveryone.id,
            workspaceId: wsAOid,
            tokenHash,
            encryptedFields,
          }),
          repo.claimSourceConnectionKeyRequest({
            id: srcEveryone.id,
            workspaceId: wsAOid,
            tokenHash,
            encryptedFields,
          }),
        ]);
        expect(claimResults.filter(Boolean)).toHaveLength(1);

        const afterClaim = await repo.findSourceConnectionById(
          srcEveryone.id,
          wsAOid,
        );
        expect(afterClaim?.isActive).toBe(true);
        expect(afterClaim?.keyRequest).toBeUndefined();
        expect(afterClaim?.config.api_key).toBe(encryptedFields.api_key);
        expect(afterClaim?.config.base_url).toBe("https://api.stripe.com");

        // Exact CAS rollback succeeds when claimed ciphertexts are untouched
        const rolledBack = await repo.rollbackSourceConnectionKeyRequest({
          id: srcEveryone.id,
          workspaceId: wsAOid,
          encryptedFields,
          keyRequest,
        });
        expect(rolledBack).toBe(true);

        const afterRollback = await repo.findSourceConnectionById(
          srcEveryone.id,
          wsAOid,
        );
        expect(afterRollback?.isActive).toBe(false);
        expect(afterRollback?.keyRequest?.tokenHash).toBe(tokenHash);
        expect(afterRollback?.config.api_key).toBeUndefined();
        expect(afterRollback?.config.base_url).toBe("https://api.stripe.com");

        // Claim again, then manager modifies api_key -> CAS rollback MUST refuse!
        expect(
          await repo.claimSourceConnectionKeyRequest({
            id: srcEveryone.id,
            workspaceId: wsAOid,
            tokenHash,
            encryptedFields,
          }),
        ).toBe(true);

        const managerCipher = encryptString("sk_live_manager_override");
        await repo.updateSourceConnection(srcEveryone.id, wsAOid, {
          config: {
            base_url: "https://api.stripe.com",
            api_key: managerCipher,
            webhook_secret: encryptedFields.webhook_secret,
          },
        });

        const refusedRollback = await repo.rollbackSourceConnectionKeyRequest({
          id: srcEveryone.id,
          workspaceId: wsAOid,
          encryptedFields,
          keyRequest,
        });
        expect(refusedRollback).toBe(false);

        const afterRefused = await repo.findSourceConnectionById(
          srcEveryone.id,
          wsAOid,
        );
        expect(afterRefused?.isActive).toBe(true);
        expect(afterRefused?.keyRequest).toBeUndefined();
        expect(afterRefused?.config.api_key).toBe(managerCipher);

        // Delete
        expect(await repo.deleteSourceConnection(srcEveryone.id, wsAOid)).toBe(
          true,
        );
        expect(
          await repo.findSourceConnectionById(srcEveryone.id, wsAOid),
        ).toBeNull();
      });

      it("records and queries connection_access_events and connection_write_events (including listRecentWriters parity)", async () => {
        const repo = impl.create();
        const connId = newDualId().oid;
        const base = new Date("2026-11-20T12:00:00.000Z");

        await repo.recordConnectionAccessEvent({
          workspaceId: wsAOid,
          connectionId: connId,
          kind: "source",
          actor: nativeUserUuid,
          via: "app",
          changes: { liveReads: true },
          at: new Date(base.getTime() - 2000),
        });
        const newestAccess = await repo.recordConnectionAccessEvent({
          workspaceId: wsAOid,
          connectionId: connId,
          kind: "source",
          actor: nativeUserUuid,
          via: "mcp",
          changes: {
            writers: { added: [`user:${nativeUserUuid}`], removed: [] },
          },
          at: base,
        });

        const accessLog = await repo.listConnectionAccessEvents(
          wsAOid,
          connId,
          1,
        );
        expect(accessLog).toHaveLength(1);
        expect(accessLog[0].id).toBe(newestAccess.id);
        expect(accessLog[0].via).toBe("mcp");

        // Write events + outcome update + recentWriters aggregate parity
        const wOld = await repo.recordConnectionWriteEvent({
          workspaceId: wsAOid,
          connectionId: connId,
          principal: "workflow:stale-job",
          target: "POST /v1/old",
          allowed: true,
          at: new Date(base.getTime() - 40 * 86_400_000),
        });
        expect(wOld.allowed).toBe(true);

        const w1 = await repo.recordConnectionWriteEvent({
          workspaceId: wsAOid,
          connectionId: connId,
          principal: "workflow:crm-sync",
          target: "POST /v1/contacts",
          allowed: true,
          at: new Date(base.getTime() - 10_000),
        });
        await repo.recordConnectionWriteOutcome(w1.id, wsAOid, { status: 201 });

        const w2 = await repo.recordConnectionWriteEvent({
          workspaceId: wsAOid,
          connectionId: connId,
          principal: "workflow:crm-sync",
          target: "PATCH /v1/deals",
          allowed: true,
          at: new Date(base.getTime() - 5_000),
        });
        await repo.recordConnectionWriteOutcome(w2.id, wsAOid, {
          error: "upstream 502",
        });

        await repo.recordConnectionWriteEvent({
          workspaceId: wsAOid,
          connectionId: connId,
          principal: "workflow:crm-sync",
          target: "POST /v1/contacts",
          allowed: true,
          at: base,
        });

        await repo.recordConnectionWriteEvent({
          workspaceId: wsAOid,
          connectionId: connId,
          principal: `user:${nativeUserUuid}`,
          allowed: false,
          at: new Date(base.getTime() - 2_000),
        });

        const since30d = new Date(base.getTime() - 30 * 86_400_000);
        const recent = await repo.listRecentWriters(connId, since30d, wsAOid);
        expect(recent).toEqual([
          {
            principal: "workflow:crm-sync",
            count: 3,
            lastAt: base,
            targets: ["PATCH /v1/deals", "POST /v1/contacts"],
          },
          {
            principal: `user:${nativeUserUuid}`,
            count: 1,
            lastAt: new Date(base.getTime() - 2_000),
            targets: [],
          },
        ]);
      });

      it("manages connector_definitions upsert, sourceSha build/check guards, pruning, and due retry scan", async () => {
        const repo = impl.create();
        const t0 = new Date("2026-11-20T10:00:00.000Z");

        const def1 = await repo.upsertConnectorDefinition({
          workspaceId: wsAOid,
          slug: "stripe-custom",
          sha: "tree-sha-1",
          sourceSha: "src-sha-1",
          status: "indexed",
          entities: ["customers", "invoices"],
          hasIcon: true,
          spec: { version: 1, auth: "api_key" },
          registry: {
            ref: "@mako/stripe",
            slug: "stripe",
            range: "^1.0.0",
            version: "1.2.0",
            hash: "h1",
            sha256: "s256",
            latest: "1.3.0",
            upgradeAvailable: "1.3.0",
            resolvedAt: t0,
          },
          now: t0,
        });
        expect(def1.slug).toBe("stripe-custom");
        expect(def1.registry?.upgradeAvailable).toBe("1.3.0");

        // Build guard: stale sourceSha rejected; matching sourceSha succeeds
        expect(
          await repo.recordConnectorDefinitionBuild(
            wsAOid,
            "stripe-custom",
            { status: "built", hash: "b-stale", bytes: 100, builtAt: t0 },
            { expectedSourceSha: "wrong-sha", now: t0 },
          ),
        ).toBe(false);
        expect(
          await repo.recordConnectorDefinitionBuild(
            wsAOid,
            "stripe-custom",
            { status: "built", hash: "b-ok", bytes: 2048, builtAt: t0 },
            { expectedSourceSha: "src-sha-1", now: t0 },
          ),
        ).toBe(true);
        expect(
          (await repo.findConnectorDefinition(wsAOid, "stripe-custom"))?.build,
        ).toMatchObject({ status: "built", hash: "b-ok", bytes: 2048 });

        // Check result guard: ok: false -> indexed + lastCheckError; ok: true -> verified & clears error
        const tCheck1 = new Date("2026-11-20T10:05:00.000Z");
        expect(
          await repo.recordConnectorDefinitionCheckResult(
            wsAOid,
            "stripe-custom",
            {
              ok: false,
              checkedAt: tCheck1,
              expectedSourceSha: "wrong-sha",
              error: "ignored",
            },
          ),
        ).toBe(false);
        expect(
          await repo.recordConnectorDefinitionCheckResult(
            wsAOid,
            "stripe-custom",
            {
              ok: false,
              checkedAt: tCheck1,
              expectedSourceSha: "src-sha-1",
              error: "401 Unauthorized",
            },
          ),
        ).toBe(true);
        const afterFail = await repo.findConnectorDefinition(
          wsAOid,
          "stripe-custom",
        );
        expect(afterFail?.status).toBe("indexed");
        expect(afterFail?.lastCheckError).toBe("401 Unauthorized");

        const tCheck2 = new Date("2026-11-20T10:06:00.000Z");
        expect(
          await repo.recordConnectorDefinitionCheckResult(
            wsAOid,
            "stripe-custom",
            { ok: true, checkedAt: tCheck2, expectedSourceSha: "src-sha-1" },
          ),
        ).toBe(true);
        const afterPass = await repo.findConnectorDefinition(
          wsAOid,
          "stripe-custom",
        );
        expect(afterPass?.status).toBe("verified");
        expect(afterPass?.lastCheckError).toBeUndefined();

        // Retrying & blocked definitions: checkResult MUST NOT overwrite blocked/retrying
        const dueAt = new Date("2026-11-20T09:55:00.000Z");
        const futureRetryAt = new Date("2026-11-20T12:00:00.000Z");
        await repo.upsertConnectorDefinition({
          workspaceId: wsAOid,
          slug: "retrying-due",
          sha: "sha-r1",
          sourceSha: "src-r1",
          status: "retrying",
          indexRetryAttempts: 2,
          nextIndexRetryAt: dueAt,
          now: t0,
        });
        await repo.upsertConnectorDefinition({
          workspaceId: wsBOid,
          slug: "retrying-future",
          sha: "sha-r2",
          sourceSha: "src-r2",
          status: "retrying",
          indexRetryAttempts: 1,
          nextIndexRetryAt: futureRetryAt,
          now: t0,
        });
        await repo.upsertConnectorDefinition({
          workspaceId: wsAOid,
          slug: "blocked-conn",
          sha: "sha-b1",
          sourceSha: "src-b1",
          status: "blocked",
          blockedReason: "forbidden import",
          now: t0,
        });

        expect(
          await repo.recordConnectorDefinitionCheckResult(
            wsAOid,
            "blocked-conn",
            { ok: true, checkedAt: tCheck2 },
          ),
        ).toBe(false);

        expect(await repo.listWorkspaceIdsWithDueRetries(t0)).toEqual([wsAOid]);
        expect(
          (await repo.listWorkspaceIdsWithDueRetries(futureRetryAt)).sort(),
        ).toEqual([wsAOid, wsBOid].sort());

        // Pruning & delete
        const pruned = await repo.deleteConnectorDefinitionsNotInSlugs(wsAOid, [
          "stripe-custom",
        ]);
        expect(pruned).toHaveLength(2);
        expect(
          (await repo.listConnectorDefinitions(wsAOid)).map(d => d.slug),
        ).toEqual(["stripe-custom"]);

        expect(
          await repo.deleteConnectorDefinition(wsAOid, "stripe-custom"),
        ).toBe(true);
        expect(await repo.listConnectorDefinitions(wsAOid)).toEqual([]);
      });
    });
  }

  // ── 3. PG user:<legacyId> -> user:<uuid> principal rewriting ────────────

  it("rewrites user:<legacyId> principals and FKs to PG UUIDv7 across all 5 tables while passing workflow/worker principals through verbatim", async () => {
    const pgRepo = new PgConnectionsRepository({ getDb: () => db });
    const now = new Date("2026-11-21T10:00:00.000Z");

    const dbConn = await pgRepo.createDatabaseConnection({
      workspaceId: wsAOid,
      name: "Rewritten DB",
      type: "postgresql",
      connection: { host: "pg.local" },
      writers: [
        {
          principal: `user:${legacyUserId}`,
          where: "app.*",
          addedBy: legacyUserId,
          addedAt: now,
        },
        {
          principal: "workflow:nightly-etl",
          addedBy: "system",
          addedAt: now,
        },
      ],
      createdBy: legacyUserId,
      createdAt: now,
    });
    expect(dbConn.createdBy).toBe(legacyUserUuid);
    expect(dbConn.writers).toEqual([
      {
        principal: `user:${legacyUserUuid}`,
        where: "app.*",
        addedBy: legacyUserUuid,
        addedAt: now,
      },
      {
        principal: "workflow:nightly-etl",
        addedBy: "system",
        addedAt: now,
      },
    ]);

    const srcConn = await pgRepo.createSourceConnection({
      workspaceId: wsAOid,
      name: "Rewritten Source",
      type: "linear",
      config: {},
      settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
      writers: [{ principal: `agent:user:${legacyUserId}` }],
      liveReads: true,
      liveReaders: [{ principal: `user:${legacyUserId}` }],
      managers: [legacyUserId, "system"],
      createdBy: legacyUserId,
      keyRequest: {
        tokenHash: sha256Hex("rw-tok"),
        expiresAt: new Date(now.getTime() + 60_000),
        fields: ["api_key"],
        requestedBy: legacyUserId,
        createdAt: now,
      },
      createdAt: now,
    });
    expect(srcConn.createdBy).toBe(legacyUserUuid);
    expect(srcConn.writers?.[0].principal).toBe(`agent:user:${legacyUserUuid}`);
    expect(srcConn.liveReaders?.[0].principal).toBe(`user:${legacyUserUuid}`);
    // Non-user "system" dropped from uuid[] managers
    expect(srcConn.managers).toEqual([legacyUserUuid]);
    expect(srcConn.keyRequest?.requestedBy).toBe(legacyUserUuid);

    // Access events: user actor -> actor_user_id + changes rewritten; non-user -> actor_raw
    const accUser = await pgRepo.recordConnectionAccessEvent({
      workspaceId: wsAOid,
      connectionId: srcConn.id,
      kind: "source",
      actor: legacyUserId,
      via: "app",
      changes: {
        writers: {
          added: [`user:${legacyUserId} public.orders`, "workflow:*"],
          removed: [],
        },
        managers: { added: [legacyUserId], removed: [] },
      },
      at: now,
    });
    expect(accUser.actor).toBe(legacyUserUuid);
    expect(accUser.changes.writers?.added).toEqual([
      `user:${legacyUserUuid} public.orders`,
      "workflow:*",
    ]);
    expect(accUser.changes.managers?.added).toEqual([legacyUserUuid]);

    const accSystem = await pgRepo.recordConnectionAccessEvent({
      workspaceId: wsAOid,
      connectionId: srcConn.id,
      kind: "source",
      actor: "unknown",
      via: "api",
      changes: { liveReads: true },
      at: now,
    });
    expect(accSystem.actor).toBe("unknown");

    // Write events: all 4 user principal prefixes rewrite + populate actor_user_id; worker/workflow untouched
    await pgRepo.recordConnectionWriteEvent({
      workspaceId: wsAOid,
      connectionId: srcConn.id,
      principal: `dry-run:agent:user:${legacyUserId}`,
      target: "POST /v1/issues",
      allowed: true,
      at: now,
    });
    await pgRepo.recordConnectionWriteEvent({
      workspaceId: wsAOid,
      connectionId: srcConn.id,
      principal: "worker:workflows",
      target: "POST /v1/issues",
      allowed: true,
      at: now,
    });

    const rawWriteRows = await db.select().from(pgSchema.connectionWriteEvents);
    const byPrincipal = new Map(rawWriteRows.map(r => [r.principal, r]));
    expect(
      byPrincipal.get(`dry-run:agent:user:${legacyUserUuid}`)?.actorUserId,
    ).toBe(legacyUserUuid);
    expect(byPrincipal.get("worker:workflows")?.actorUserId).toBeNull();
  });

  // ── 4. Byte-identical dual-write + 5 workspace-scoped stages + rollback ─

  it("runs all 5 workspace-scoped stages with byte-identical ciphertext, per-workspace isolation, secret redaction, and zero-loss Stage 4 -> Stage 2 rollback", async () => {
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
    const mongoRepo = new MongoConnectionsRepository();
    const pgRepo = new PgConnectionsRepository({ getDb: () => db });
    const dual = new DualConnectionsRepository({
      mongo: mongoRepo,
      pg: pgRepo,
      router,
      getDb: () => db,
    });

    // Stage 1: mongo_only (both workspaces)
    const wsBOnly = await dual.createDatabaseConnection({
      workspaceId: wsBOid,
      name: "Control DB",
      type: "postgresql",
      connection: { host: "ctrl.local", password: "ctrl-password" },
      createdBy: nativeUserUuid,
    });
    expect(
      await mongoRepo.findDatabaseConnectionById(wsBOnly.id),
    ).not.toBeNull();
    expect(await pgRepo.findDatabaseConnectionById(wsBOnly.id)).toBeNull();

    // Advance ONLY Workspace A to Stage 2 (`dual_write_mongo_read`) — Workspace B stays Stage 1!
    await router.setDomainState({
      domain: "connections",
      workspaceId: wsAOid,
      mode: "dual_write_mongo_read",
    });

    const wsAStage2 = await dual.createDatabaseConnection({
      workspaceId: wsAOid,
      name: "Stage2 PG",
      type: "postgresql",
      connection: {
        host: "s2.internal",
        password: "ultra-secret-stage2-pw",
        sshTunnel: {
          enabled: true,
          host: "bastion.s2",
          privateKey: "ssh-key-stage2",
        },
      },
      createdBy: nativeUserUuid,
    });

    // Verify BYTE-IDENTICAL ciphertext in raw MongoDB & Postgres!
    const mongoRaw1 = await DatabaseConnection.collection.findOne({
      _id: new mongoose.Types.ObjectId(wsAStage2.id),
    });
    const pgRow1 = (
      await db
        .select()
        .from(pgSchema.databaseConnections)
        .where(
          eq(pgSchema.databaseConnections.id, objectIdToUuid(wsAStage2.id)),
        )
    )[0];
    expect(mongoRaw1?.connection).toEqual(pgRow1.connectionEncrypted);
    expect(JSON.stringify(pgRow1.connectionEncrypted)).not.toContain(
      "ultra-secret-stage2-pw",
    );

    // Update also writes byte-identical ciphertext to both stores
    await dual.updateDatabaseConnection(wsAStage2.id, wsAOid, {
      connection: { host: "s2-v2.internal", password: "rotated-stage2-pw" },
    });
    const mongoRaw2 = await DatabaseConnection.collection.findOne({
      _id: new mongoose.Types.ObjectId(wsAStage2.id),
    });
    const pgRow2 = (
      await db
        .select()
        .from(pgSchema.databaseConnections)
        .where(
          eq(pgSchema.databaseConnections.id, objectIdToUuid(wsAStage2.id)),
        )
    )[0];
    expect(mongoRaw2?.connection).toEqual(pgRow2.connectionEncrypted);

    // Workspace B is STILL in Stage 1 (`mongo_only`) — writes stay Mongo-only!
    const wsBStillMongo = await dual.createSourceConnection({
      workspaceId: wsBOid,
      name: "Control Source",
      type: "stripe",
      config: {},
      settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
      createdBy: nativeUserUuid,
    });
    expect(await pgRepo.findSourceConnectionById(wsBStillMongo.id)).toBeNull();

    // Stage 2 wrong-workspace delete MUST NOT record any tombstone
    expect(await dual.deleteDatabaseConnection(wsAStage2.id, wsBOid)).toBe(
      false,
    );
    expect(await db.select().from(pgSchema.migrationTombstones)).toHaveLength(
      0,
    );

    // Stage 2 delete records tombstone in migration_tombstones
    const toDelete = await dual.createDatabaseConnection({
      workspaceId: wsAOid,
      name: "Temp DB",
      type: "sqlite",
      connection: { database: "/tmp/t.db" },
      createdBy: nativeUserUuid,
    });
    expect(await dual.deleteDatabaseConnection(toDelete.id, wsAOid)).toBe(true);
    const tombstones = await db.select().from(pgSchema.migrationTombstones);
    expect(tombstones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "database_connections",
          entityId: objectIdToUuid(toDelete.id),
        }),
      ]),
    );

    // Stage 3: dual_write_shadow_compare (100% sample rate) on Workspace A
    await router.setDomainState({
      domain: "connections",
      workspaceId: wsAOid,
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 1,
    });

    const srcStage3 = await dual.createSourceConnection({
      workspaceId: wsAOid,
      name: "Stage3 Source",
      type: "hubspot",
      config: { api_key: encryptString("secret-stage3-api-key") },
      settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
      liveReads: true,
      liveReaders: [],
      writers: [{ principal: `user:${legacyUserId}`, addedBy: legacyUserId }],
      managers: [legacyUserId],
      createdBy: legacyUserId,
    });

    expect(
      (await dual.findDatabaseConnectionById(wsAStage2.id, wsAOid))?.connection
        .password,
    ).toBe("rotated-stage2-pw");
    expect(
      (await dual.findSourceConnectionById(srcStage3.id, wsAOid))?.liveReaders,
    ).toEqual([]);
    // UUIDv8 lookup symmetry in findSourceConnectionByIdOrName across both stores
    expect(
      (
        await dual.findSourceConnectionByIdOrName(
          wsAOid,
          objectIdToUuid(srcStage3.id),
        )
      ).connection?.id,
    ).toBe(srcStage3.id);
    await shadowRunner.flush();
    expect(shadowEvents.slice(-3).every(e => e.result === "match")).toBe(true);

    // Inject deliberate secret drift in PG -> verify mismatch AND strict secret redaction!
    await db
      .update(pgSchema.databaseConnections)
      .set({
        connectionEncrypted: encryptConnectionObject({
          host: "s2-v2.internal",
          password: "drifted-pg-secret-value",
        }),
      })
      .where(eq(pgSchema.databaseConnections.id, objectIdToUuid(wsAStage2.id)));

    await dual.findDatabaseConnectionById(wsAStage2.id, wsAOid);
    await shadowRunner.flush();
    const driftEvent = shadowEvents.at(-1);
    expect(driftEvent?.result).toBe("mismatch");
    expect(driftEvent?.diffs.every(d => d.redacted)).toBe(true);
    const serializedEvent = JSON.stringify(driftEvent);
    expect(serializedEvent).not.toContain("rotated-stage2-pw");
    expect(serializedEvent).not.toContain("drifted-pg-secret-value");

    // Heal drift before moving to Stage 4
    await dual.updateDatabaseConnection(wsAStage2.id, wsAOid, {
      connection: { host: "s2-v2.internal", password: "rotated-stage2-pw" },
    });

    // Stage 4: dual_write_pg_read (PG primary, Mongo secondary)
    await router.setDomainState({
      domain: "connections",
      workspaceId: wsAOid,
      mode: "dual_write_pg_read",
      shadowSampleRate: 1,
    });

    const dbStage4 = await dual.createDatabaseConnection({
      workspaceId: wsAOid,
      name: "Stage4 DB",
      type: "mysql",
      connection: { host: "mysql.s4", password: "s4-mysql-password" },
      createdBy: nativeUserUuid,
    });
    const defStage4 = await dual.upsertConnectorDefinition({
      workspaceId: wsAOid,
      slug: "s4-connector",
      sha: "sha-s4",
      sourceSha: "src-s4",
      status: "indexed",
    });
    const writeStage4 = await dual.recordConnectionWriteEvent({
      workspaceId: wsAOid,
      connectionId: dbStage4.id,
      principal: "workflow:s4",
      target: "INSERT orders",
      allowed: true,
    });
    await dual.recordConnectionWriteOutcome(writeStage4.id, wsAOid, {
      status: 200,
    });

    // Stage 4 reverse shadow compare matches cleanly
    expect(
      (await dual.findDatabaseConnectionById(dbStage4.id, wsAOid))?.connection
        .password,
    ).toBe("s4-mysql-password");
    expect(
      (await dual.findConnectorDefinition(wsAOid, "s4-connector"))?.id,
    ).toBe(defStage4.id);
    await shadowRunner.flush();
    expect(shadowEvents.slice(-2).every(e => e.result === "match")).toBe(true);

    // INSTANT ROLLBACK: Stage 4 -> Stage 2 -> every Stage 4 write exists verbatim in Mongo!
    await router.setDomainState({
      domain: "connections",
      workspaceId: wsAOid,
      mode: "dual_write_mongo_read",
    });
    const rolledBackDb = await dual.findDatabaseConnectionById(
      dbStage4.id,
      wsAOid,
    );
    expect(rolledBackDb?.connection.password).toBe("s4-mysql-password");
    expect(
      (await dual.findConnectorDefinition(wsAOid, "s4-connector"))?.sha,
    ).toBe("sha-s4");
    const rolledBackWriters = await dual.listRecentWriters(
      dbStage4.id,
      new Date(Date.now() - 60_000),
      wsAOid,
    );
    expect(rolledBackWriters).toHaveLength(1);
    expect(rolledBackWriters[0].principal).toBe("workflow:s4");

    // Stage 5: pg_only on Workspace A (Workspace B still unaffected!)
    await router.setDomainState({
      domain: "connections",
      workspaceId: wsAOid,
      mode: "pg_only",
    });
    const dbStage5 = await dual.createDatabaseConnection({
      workspaceId: wsAOid,
      name: "Stage5 PG Only",
      type: "postgresql",
      connection: { host: "s5.local", password: "s5-password" },
      createdBy: nativeUserUuid,
    });
    expect(await pgRepo.findDatabaseConnectionById(dbStage5.id)).not.toBeNull();
    expect(await mongoRepo.findDatabaseConnectionById(dbStage5.id)).toBeNull();
    expect(
      await dual.findDatabaseConnectionById(wsBOnly.id, wsBOid),
    ).not.toBeNull();

    expect(failures).toHaveLength(0);
  });

  // ── 5. Secondary write failure isolation & bidirectional sync-retry ─────

  it("isolates secondary write failures and heals parity via bidirectional sync-retry without secrets in retry payloads", async () => {
    const captured: SecondaryWriteFailureContext[] = [];
    const router = new MigrationRouter({
      enablePubSub: false,
      onSecondaryFailure: async ctx => {
        captured.push(ctx);
      },
    });
    const mongoRepo = new MongoConnectionsRepository();
    const brokenPgRepo = new PgConnectionsRepository({
      getDb: () => {
        throw new Error("Simulated Neon outage");
      },
    });
    const dualBrokenPg = new DualConnectionsRepository({
      mongo: mongoRepo,
      pg: brokenPgRepo,
      router,
      getDb: () => db,
    });

    await router.setDomainState({
      domain: "connections",
      workspaceId: wsAOid,
      mode: "dual_write_mongo_read",
    });

    // Stage 2: Mongo succeeds while PG fails
    const dbConn = await dualBrokenPg.createDatabaseConnection({
      workspaceId: wsAOid,
      name: "Retry DB",
      type: "postgresql",
      connection: { host: "retry.local", password: "never-in-retry-payload" },
      createdBy: legacyUserId,
    });
    expect(captured).toHaveLength(1);
    expect(captured[0].target).toBe("pg");
    expect(JSON.stringify(captured[0])).not.toContain("never-in-retry-payload");

    const pgRepo = new PgConnectionsRepository({ getDb: () => db });
    expect(await pgRepo.findDatabaseConnectionById(dbConn.id)).toBeNull();

    // Replay into PG via registered sync-retry handler -> byte-identical ciphertext!
    const pgEvent: SyncRetryEventData = {
      target: "pg",
      domain: captured[0].domain,
      operation: captured[0].operation,
      entityId: captured[0].entityId ?? "unknown",
      workspaceId: wsAOid,
      payload: captured[0].payload,
      failedAt: new Date().toISOString(),
      errorMessage: "Simulated Neon outage",
    };
    await replayConnectionsWriteToPg(pgEvent, db);

    const healedPg = await pgRepo.findDatabaseConnectionById(dbConn.id, wsAOid);
    expect(healedPg?.connection.password).toBe("never-in-retry-payload");
    expect(healedPg?.createdBy).toBe(legacyUserUuid);

    // Stage 4: PG succeeds while Mongo fails -> replayConnectionsWriteToMongo heals Mongo!
    const brokenMongo = Object.create(mongoRepo) as MongoConnectionsRepository;
    brokenMongo.updateDatabaseConnection = async () => {
      throw new Error("Simulated Atlas outage");
    };
    const dualBrokenMongo = new DualConnectionsRepository({
      mongo: brokenMongo,
      pg: pgRepo,
      router,
      getDb: () => db,
    });

    await router.setDomainState({
      domain: "connections",
      workspaceId: wsAOid,
      mode: "dual_write_pg_read",
    });

    await dualBrokenMongo.updateDatabaseConnection(dbConn.id, wsAOid, {
      name: "Retry DB Updated",
      connection: { host: "retry-v2.local", password: "stage4-healed-pw" },
    });
    expect(captured).toHaveLength(2);
    expect(captured[1].target).toBe("mongo");
    expect(
      (await mongoRepo.findDatabaseConnectionById(dbConn.id, wsAOid))?.name,
    ).toBe("Retry DB");

    await replayConnectionsWriteToMongo(
      {
        target: "mongo",
        domain: captured[1].domain,
        operation: captured[1].operation,
        entityId: captured[1].entityId ?? "unknown",
        workspaceId: wsAOid,
        payload: captured[1].payload,
        failedAt: new Date().toISOString(),
        errorMessage: "Simulated Atlas outage",
      },
      db,
    );

    const healedMongo = await mongoRepo.findDatabaseConnectionById(
      dbConn.id,
      wsAOid,
    );
    expect(healedMongo?.name).toBe("Retry DB Updated");
    expect(healedMongo?.connection.password).toBe("stage4-healed-pw");
  });

  // ── 6. FK-ordered Backfill, Parity Verifier (--repair) & 90d TTL Reaper ─

  it("backfills all 5 tables in FK order, preserves ciphertext & live_readers NULL vs [], guards stale/tombstones/orphans, repairs parity without getPgDb(), and reaps ONLY 90d connection_write_events", async () => {
    clearBackfillRegistryForTests();
    clearVerifierRegistryForTests();
    clearTtlRegistryForTests();
    registerMigrationDomains({ force: true });

    expect(
      listBackfillDomains()
        .filter(d => d === "connections" || d.startsWith("connections:"))
        .sort(),
    ).toEqual([
      "connections",
      "connections:connection_access_events",
      "connections:connection_write_events",
      "connections:connector_definitions",
      "connections:database_connections",
      "connections:source_connections",
    ]);
    expect(
      listVerifierDomains()
        .filter(d => d === "connections" || d.startsWith("connections:"))
        .sort(),
    ).toEqual([
      "connections",
      "connections:connection_access_events",
      "connections:connection_write_events",
      "connections:connector_definitions",
      "connections:database_connections",
      "connections:source_connections",
    ]);

    const t0 = new Date("2026-11-15T10:00:00.000Z");
    const tNewer = new Date("2026-11-15T12:00:00.000Z");
    const wsOid = new mongoose.Types.ObjectId(wsAOid);
    const orphanWsOid = new mongoose.Types.ObjectId(newDualId().oid);

    const dbNormalId = newDualId(t0.getTime()).oid;
    const dbLegacyJsonId = newDualId(t0.getTime() + 1000).oid;
    const dbStaleId = newDualId(t0.getTime() + 2000).oid;
    const dbTombstonedId = newDualId(t0.getTime() + 3000).oid;
    const dbOrphanId = newDualId(t0.getTime() + 4000).oid;

    const rawCipherNormal = encryptConnectionObject({
      host: "backfill.local",
      password: "verbatim-backfill-password",
    });
    const rawCipherLegacyJson = encryptConnectionObject({
      host: "legacy-json.local",
      password: "legacy-json-password",
    });

    await recordMigrationTombstone(
      "database_connections",
      objectIdToUuid(dbTombstonedId),
      db,
    );

    // Pre-populate newer live PG row for dbStaleId
    const pgRepo = new PgConnectionsRepository({ getDb: () => db });
    await pgRepo.createDatabaseConnection({
      id: dbStaleId,
      workspaceId: wsAOid,
      name: "Live Newer PG Name",
      type: "postgresql",
      connection: { host: "newer.local", password: "newer-live-pw" },
      createdBy: legacyUserId,
      createdAt: t0,
      updatedAt: tNewer,
    });

    await DatabaseConnection.collection.insertMany([
      {
        _id: new mongoose.Types.ObjectId(dbNormalId),
        workspaceId: wsOid,
        name: "Backfill Normal",
        type: "postgresql",
        connection: rawCipherNormal,
        isDemo: false,
        allowAgentWrites: false,
        writers: [{ principal: `user:${legacyUserId}`, addedBy: legacyUserId }],
        createdBy: legacyUserId,
        createdAt: t0,
        updatedAt: t0,
      },
      {
        _id: new mongoose.Types.ObjectId(dbLegacyJsonId),
        workspaceId: wsOid,
        name: "Legacy JSON String Conn",
        type: "mysql",
        connection: JSON.stringify(rawCipherLegacyJson),
        isDemo: false,
        allowAgentWrites: false,
        createdBy: legacyUserId,
        createdAt: t0,
        updatedAt: t0,
      },
      {
        _id: new mongoose.Types.ObjectId(dbStaleId),
        workspaceId: wsOid,
        name: "Stale Mongo Name",
        type: "postgresql",
        connection: encryptConnectionObject({ host: "old.local" }),
        isDemo: false,
        allowAgentWrites: false,
        createdBy: legacyUserId,
        createdAt: t0,
        updatedAt: t0,
      },
      {
        _id: new mongoose.Types.ObjectId(dbTombstonedId),
        workspaceId: wsOid,
        name: "Deleted Tombstone",
        type: "sqlite",
        connection: {},
        createdBy: legacyUserId,
        createdAt: t0,
        updatedAt: t0,
      },
      {
        _id: new mongoose.Types.ObjectId(dbOrphanId),
        workspaceId: orphanWsOid,
        name: "Orphan Workspace DB",
        type: "postgresql",
        connection: {},
        createdBy: legacyUserId,
        createdAt: t0,
        updatedAt: t0,
      },
    ]);

    // Source connections: one liveReaders absent (NULL) + one liveReaders: []
    const srcEveryoneId = newDualId(t0.getTime() + 5000).oid;
    const srcWritersOnlyId = newDualId(t0.getTime() + 6000).oid;
    await SourceConnection.collection.insertMany([
      {
        _id: new mongoose.Types.ObjectId(srcEveryoneId),
        workspaceId: wsOid,
        name: "Backfill Everyone",
        type: "stripe",
        config: { api_key: encryptString("bf-stripe") },
        settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
        targetDatabases: [new mongoose.Types.ObjectId(dbNormalId)],
        liveReads: true,
        createdBy: legacyUserId,
        isActive: true,
        createdAt: t0,
        updatedAt: t0,
      },
      {
        _id: new mongoose.Types.ObjectId(srcWritersOnlyId),
        workspaceId: wsOid,
        name: "Backfill Writers Only",
        type: "hubspot",
        config: {},
        settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
        targetDatabases: [],
        liveReads: true,
        liveReaders: [],
        createdBy: legacyUserId,
        isActive: true,
        createdAt: t0,
        updatedAt: t0,
      },
    ]);

    // Connector definition
    const defId = newDualId(t0.getTime() + 7000).oid;
    await ConnectorDefinition.collection.insertOne({
      _id: new mongoose.Types.ObjectId(defId),
      workspaceId: wsOid,
      slug: "backfill-conn",
      runtime: "node",
      entry: "connector.ts",
      sha: "bf-sha",
      sourceSha: "bf-src-sha",
      status: "verified",
      entities: ["orders"],
      hasIcon: false,
      createdAt: t0,
      updatedAt: t0,
    });

    // Permanent access event (180 days old — MUST survive TTL reaper!)
    const accOldId = newDualId(t0.getTime() + 8000).oid;
    const days180Ago = new Date(Date.now() - 180 * 86_400_000);
    await ConnectionAccessEvent.collection.insertOne({
      _id: new mongoose.Types.ObjectId(accOldId),
      workspaceId: wsOid,
      connectionId: new mongoose.Types.ObjectId(srcEveryoneId),
      kind: "source",
      actor: legacyUserId,
      via: "app",
      changes: { liveReads: true },
      at: days180Ago,
    });

    // Write events: 1 recent (pre-inserted in PG without status -> COALESCE merge!) + 1 expired (120d old)
    const writeRecentId = newDualId(t0.getTime() + 9000).oid;
    const writeExpiredId = newDualId(t0.getTime() + 10000).oid;
    const days10Ago = new Date(Date.now() - 10 * 86_400_000);
    const days120Ago = new Date(Date.now() - 120 * 86_400_000);

    await pgRepo.recordConnectionWriteEvent({
      id: writeRecentId,
      workspaceId: wsAOid,
      connectionId: srcEveryoneId,
      principal: `user:${legacyUserId}`,
      target: "POST /v1/charges",
      allowed: true,
      at: days10Ago,
    });

    await ConnectionWriteEvent.collection.insertMany([
      {
        _id: new mongoose.Types.ObjectId(writeRecentId),
        workspaceId: wsOid,
        connectionId: new mongoose.Types.ObjectId(srcEveryoneId),
        principal: `user:${legacyUserId}`,
        target: "POST /v1/charges",
        allowed: true,
        status: 200,
        at: days10Ago,
      },
      {
        _id: new mongoose.Types.ObjectId(writeExpiredId),
        workspaceId: wsOid,
        connectionId: new mongoose.Types.ObjectId(srcEveryoneId),
        principal: "workflow:old-sync",
        target: "POST /v1/legacy",
        allowed: true,
        status: 201,
        at: days120Ago,
      },
    ]);

    // Pause after 2 batches of 3, then resume to completion
    const pass1 = await runBackfill({
      domain: "connections",
      batchSize: 3,
      maxBatches: 2,
      db,
    });
    expect(pass1.status).toBe("paused");
    expect(pass1.batchesRun).toBe(2);

    const pass2 = await runBackfill({
      domain: "connections",
      batchSize: 3,
      db,
    });
    expect(pass2.status).toBe("completed");
    expect(pass2.rowsSkippedTombstone).toBe(1);
    expect(pass2.rowsQuarantined).toBe(1);

    // Raw ciphertext preserved verbatim in PG
    const pgNormalRow = (
      await db
        .select()
        .from(pgSchema.databaseConnections)
        .where(eq(pgSchema.databaseConnections.id, objectIdToUuid(dbNormalId)))
    )[0];
    expect(pgNormalRow.connectionEncrypted).toEqual(rawCipherNormal);
    expect(pgNormalRow.createdBy).toBe(legacyUserUuid);
    expect(pgNormalRow.writers?.[0].principal).toBe(`user:${legacyUserUuid}`);

    // Legacy JSON-stringified connection parsed and decrypted cleanly
    expect(
      (await pgRepo.findDatabaseConnectionById(dbLegacyJsonId, wsAOid))
        ?.connection.password,
    ).toBe("legacy-json-password");

    // Stale updatedAt guard protected live PG row
    expect(
      (await pgRepo.findDatabaseConnectionById(dbStaleId, wsAOid))?.name,
    ).toBe("Live Newer PG Name");

    // Tombstone prevented resurrection; orphan quarantined
    expect(await pgRepo.findDatabaseConnectionById(dbTombstonedId)).toBeNull();
    const quarantined = await db.select().from(pgSchema.migrationQuarantine);
    expect(quarantined).toHaveLength(1);
    expect(quarantined[0].reason).toBe("orphaned_workspace_missing");

    // live_readers NULL vs [] preserved identically
    expect(
      (await pgRepo.findSourceConnectionById(srcEveryoneId, wsAOid))
        ?.liveReaders,
    ).toBeUndefined();
    expect(
      (await pgRepo.findSourceConnectionById(srcWritersOnlyId, wsAOid))
        ?.liveReaders,
    ).toEqual([]);

    // COALESCE merged status=200 onto pre-existing write event row
    expect(
      (await pgRepo.findConnectionWriteEventById(writeRecentId, db))?.status,
    ).toBe(200);

    // Align Mongo orphan & stale doc so parity verifier tests clean drift + --repair
    await DatabaseConnection.collection.deleteOne({
      _id: new mongoose.Types.ObjectId(dbOrphanId),
    });
    const livePgStaleRow = (
      await db
        .select()
        .from(pgSchema.databaseConnections)
        .where(eq(pgSchema.databaseConnections.id, objectIdToUuid(dbStaleId)))
    )[0];
    await DatabaseConnection.collection.updateOne(
      { _id: new mongoose.Types.ObjectId(dbStaleId) },
      {
        $set: {
          name: "Live Newer PG Name",
          connection: livePgStaleRow.connectionEncrypted,
          updatedAt: tNewer,
        },
      },
    );

    // Introduce drift in PG: delete connector_definition + corrupt db name + corrupt live_readers
    await db
      .delete(pgSchema.connectorDefinitions)
      .where(eq(pgSchema.connectorDefinitions.id, objectIdToUuid(defId)));
    await db
      .update(pgSchema.databaseConnections)
      .set({ name: "Drifted Name" })
      .where(eq(pgSchema.databaseConnections.id, objectIdToUuid(dbNormalId)));
    await db
      .update(pgSchema.sourceConnections)
      .set({ liveReaders: [] })
      .where(eq(pgSchema.sourceConnections.id, objectIdToUuid(srcEveryoneId)));

    // Prove parity verifier + --repair use ONLY injected `db` (never call getPgDb()!)
    resetPgTestDb();
    const prevPgUrl = process.env.POSTGRES_URL;
    delete process.env.POSTGRES_URL;
    try {
      const driftReport = await runParityVerification({
        domain: "connections",
        batchSize: 4,
        repair: true,
        db,
      });
      expect(driftReport.ok).toBe(false);
      expect(driftReport.skippedTombstone).toBe(1);
      expect(driftReport.missingInPg).toBe(1);
      expect(driftReport.mismatched).toBe(2);
      expect(driftReport.repaired).toBe(3);

      const cleanReport = await runParityVerification({
        domain: "connections",
        batchSize: 4,
        db,
      });
      expect(cleanReport.ok).toBe(true);
      expect(cleanReport.missingInPg).toBe(0);
      expect(cleanReport.mismatched).toBe(0);
      expect(cleanReport.extraInPg).toBe(0);
      expect(cleanReport.skippedTombstone).toBe(1);

      const tableReport = await runParityVerification({
        domain: "connections:source_connections",
        batchSize: 4,
        db,
      });
      expect(tableReport.ok).toBe(true);
    } finally {
      if (prevPgUrl !== undefined) {
        process.env.POSTGRES_URL = prevPgUrl;
      }
      setPgTestDb(db);
    }

    // 90-day TTL reaper: connection_write_events ONLY (`connection_access_events` has NO TTL!)
    const ruleTables = listTtlRules().map(r => r.tableName);
    expect(ruleTables).toContain("connection_write_events");
    expect(ruleTables).not.toContain("connection_access_events");

    const reapRes = await reapAllRegisteredTables({ db, now: new Date() });
    expect(Object.keys(reapRes.errors)).toHaveLength(0);
    const deletedByTable = new Map(
      reapRes.results.map(r => [r.tableName, r.deleted]),
    );
    expect(deletedByTable.get("connection_write_events")).toBe(1);

    // 120d write event reaped; 10d write event kept; 180d access event SURVIVED untouched!
    expect(
      await pgRepo.findConnectionWriteEventById(writeExpiredId, db),
    ).toBeNull();
    expect(
      await pgRepo.findConnectionWriteEventById(writeRecentId, db),
    ).not.toBeNull();
    const survivedAccess = await pgRepo.findConnectionAccessEventById(
      accOldId,
      db,
    );
    expect(survivedAccess).not.toBeNull();
    expect(toWireId(objectIdToUuid(accOldId))).toBe(accOldId);
  });

  // ── 7. Verifier #69 hardening regressions (#1-#6) ──────────────────────

  it("handles UUIDv8 deletes, wrong-workspace delete retries, atomic connector def deletion tombstones, guarded --repair + slug PK reconciliation, atomic partial upserts, Stage 5 canary due-retries, invalid-ID guards, and empty rollback $unset", async () => {
    const captured: SecondaryWriteFailureContext[] = [];
    const router = new MigrationRouter({
      enablePubSub: false,
      onSecondaryFailure: async ctx => {
        captured.push(ctx);
      },
    });
    const mongoRepo = new MongoConnectionsRepository();
    const pgRepo = new PgConnectionsRepository({ getDb: () => db });
    const dual = new DualConnectionsRepository({
      mongo: mongoRepo,
      pg: pgRepo,
      router,
      getDb: () => db,
    });

    await router.setDomainState({
      domain: "connections",
      workspaceId: wsAOid,
      mode: "dual_write_mongo_read",
    });

    // #1: Deleting via bijective UUIDv8 records tombstones without throwing!
    const dbForUuidDel = await dual.createDatabaseConnection({
      workspaceId: wsAOid,
      name: "UUIDv8 Delete DB",
      type: "postgresql",
      connection: { host: "u.local", password: "pw" },
      createdBy: nativeUserUuid,
    });
    const srcForUuidDel = await dual.createSourceConnection({
      workspaceId: wsAOid,
      name: "UUIDv8 Delete Src",
      type: "stripe",
      config: {},
      settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
      createdBy: nativeUserUuid,
    });
    expect(
      await dual.deleteDatabaseConnection(
        objectIdToUuid(dbForUuidDel.id),
        wsAOid,
      ),
    ).toBe(true);
    expect(
      await dual.deleteSourceConnection(
        objectIdToUuid(srcForUuidDel.id),
        wsAOid,
      ),
    ).toBe(true);
    expect(captured).toHaveLength(0);
    const uuidTombstones = await db.select().from(pgSchema.migrationTombstones);
    expect(uuidTombstones).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "database_connections",
          entityId: objectIdToUuid(dbForUuidDel.id),
        }),
        expect.objectContaining({
          tableName: "source_connections",
          entityId: objectIdToUuid(srcForUuidDel.id),
        }),
      ]),
    );

    // #2a: Wrong-workspace delete sync-retry MUST NOT tombstone Workspace A's live row
    const liveWsADb = await dual.createDatabaseConnection({
      workspaceId: wsAOid,
      name: "Protected Live DB",
      type: "postgresql",
      connection: { host: "live.local", password: "pw" },
      createdBy: nativeUserUuid,
    });
    const liveWsASrc = await dual.createSourceConnection({
      workspaceId: wsAOid,
      name: "Protected Live Src",
      type: "hubspot",
      config: {},
      settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
      createdBy: nativeUserUuid,
    });

    await replayConnectionsWriteToPg(
      {
        target: "pg",
        domain: "connections",
        operation: "deleteDatabaseConnection",
        entityId: liveWsADb.id,
        workspaceId: wsBOid,
        payload: {
          table: "database_connections",
          connectionId: liveWsADb.id,
          workspaceId: wsBOid,
        },
        failedAt: new Date().toISOString(),
        errorMessage: "timeout",
      },
      db,
    );
    await replayConnectionsWriteToPg(
      {
        target: "pg",
        domain: "connections",
        operation: "deleteSourceConnection",
        entityId: liveWsASrc.id,
        workspaceId: wsBOid,
        payload: {
          table: "source_connections",
          connectionId: liveWsASrc.id,
          workspaceId: wsBOid,
        },
        failedAt: new Date().toISOString(),
        errorMessage: "timeout",
      },
      db,
    );
    expect(
      await pgRepo.findDatabaseConnectionById(liveWsADb.id),
    ).not.toBeNull();
    expect(await pgRepo.findSourceConnectionById(liveWsASrc.id)).not.toBeNull();
    const afterWrongWsReplay = await db
      .select()
      .from(pgSchema.migrationTombstones);
    expect(
      afterWrongWsReplay.some(
        t =>
          t.entityId === objectIdToUuid(liveWsADb.id) ||
          t.entityId === objectIdToUuid(liveWsASrc.id),
      ),
    ).toBe(false);

    // #2b: deleteConnectorDefinition captures deletedId atomically even when not yet in PG
    const notBackfilledDef = await mongoRepo.upsertConnectorDefinition({
      workspaceId: wsAOid,
      slug: "mongo-only-def",
      sha: "sha1",
      sourceSha: "src1",
      status: "indexed",
    });
    const brokenPgRepo = new PgConnectionsRepository({
      getDb: () => {
        throw new Error("Simulated PG timeout");
      },
    });
    const dualBrokenPg = new DualConnectionsRepository({
      mongo: mongoRepo,
      pg: brokenPgRepo,
      router,
      getDb: () => db,
    });
    expect(
      await dualBrokenPg.deleteConnectorDefinition(wsAOid, "mongo-only-def"),
    ).toBe(true);
    expect(captured).toHaveLength(1);
    expect(captured[0].payload?.definitionId).toBe(notBackfilledDef.id);
    await replayConnectionsWriteToPg(
      {
        target: "pg",
        domain: "connections",
        operation: "deleteConnectorDefinition",
        entityId: `${wsAOid}:mongo-only-def`,
        workspaceId: wsAOid,
        payload: captured[0].payload,
        failedAt: new Date().toISOString(),
        errorMessage: "Simulated PG timeout",
      },
      db,
    );
    const afterDefReplay = await db.select().from(pgSchema.migrationTombstones);
    expect(afterDefReplay).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          tableName: "connector_definitions",
          entityId: objectIdToUuid(notBackfilledDef.id),
        }),
      ]),
    );

    // #3: Guarded --repair protects strictly newer live PG row AND reconciles slug PK drift
    clearVerifierRegistryForTests();
    clearBackfillRegistryForTests();
    clearTtlRegistryForTests();
    registerMigrationDomains({ force: true });

    const tOld = new Date("2026-11-10T10:00:00.000Z");
    const tNew = new Date("2026-11-10T12:00:00.000Z");
    const newerPgDb = await dual.createDatabaseConnection({
      workspaceId: wsAOid,
      name: "Initial Name",
      type: "postgresql",
      connection: { host: "h1.local", password: "old-password" },
      createdBy: nativeUserUuid,
      createdAt: tOld,
      updatedAt: tOld,
    });
    // Advance ONLY PG to a strictly newer credential rotation
    await pgRepo.updateDatabaseConnection(newerPgDb.id, wsAOid, {
      name: "Rotated Live PG Name",
      connection: { host: "h2.local", password: "newer-live-password" },
      updatedAt: tNew,
    });

    // Simulate delete+recreate in Mongo for connector_definitions (same slug, new _id, newer updatedAt)
    const oldDef = await pgRepo.upsertConnectorDefinition({
      workspaceId: wsAOid,
      slug: "recreated-slug",
      sha: "old-sha",
      sourceSha: "old-src",
      status: "indexed",
      now: tOld,
    });
    const newMongoDef = await mongoRepo.upsertConnectorDefinition({
      workspaceId: wsAOid,
      slug: "recreated-slug",
      sha: "new-sha",
      sourceSha: "new-src",
      status: "verified",
      now: tNew,
    });
    expect(newMongoDef.id).not.toBe(oldDef.id);

    // Orphan workspace doc in Mongo must not crash --repair with 23503
    const orphanWsOid = new mongoose.Types.ObjectId(newDualId().oid);
    const orphanDbOid = new mongoose.Types.ObjectId(newDualId().oid);
    await DatabaseConnection.collection.insertOne({
      _id: orphanDbOid,
      workspaceId: orphanWsOid,
      name: "Orphan For Repair",
      type: "sqlite",
      connection: {},
      createdBy: nativeUserUuid,
      createdAt: tOld,
      updatedAt: tOld,
    });

    await runParityVerification({
      domain: "connections",
      workspaceId: wsAOid,
      repair: true,
      db,
    });
    // Strictly newer PG row survived --repair untouched!
    const survivedNewer = await pgRepo.findDatabaseConnectionById(
      newerPgDb.id,
      wsAOid,
    );
    expect(survivedNewer?.name).toBe("Rotated Live PG Name");
    expect(survivedNewer?.connection.password).toBe("newer-live-password");

    // Recreated connector_definition reconciled its PK to match Mongo without 23505!
    const reconciledDef = await pgRepo.findConnectorDefinition(
      wsAOid,
      "recreated-slug",
    );
    expect(reconciledDef?.id).toBe(newMongoDef.id);
    expect(reconciledDef?.sha).toBe("new-sha");
    // Repairing orphan workspace directly does not throw 23503
    await expect(
      runParityVerification({
        domain: "connections:database_connections",
        workspaceId: orphanWsOid.toHexString(),
        repair: true,
        db,
      }),
    ).resolves.toBeDefined();
    await DatabaseConnection.collection.deleteOne({ _id: orphanDbOid });

    // #4: Atomic partial upsertConnectorDefinition preserves existing optional columns
    const fullDef = await pgRepo.upsertConnectorDefinition({
      workspaceId: wsAOid,
      slug: "partial-preserve",
      sha: "sha-v1",
      sourceSha: "src-v1",
      status: "verified",
      spec: { auth: "api_key" },
      entities: ["leads", "deals"],
      hasIcon: true,
      lastCheckedAt: tOld,
      build: { status: "built", hash: "bh1", bytes: 512, builtAt: tOld },
      registry: {
        ref: "@mako/crm",
        slug: "crm",
        range: "^1.0.0",
        version: "1.0.0",
        hash: "rh1",
        sha256: "s256",
        latest: "1.0.0",
        resolvedAt: tOld,
      },
      now: tOld,
    });
    const partialUpdated = await pgRepo.upsertConnectorDefinition({
      workspaceId: wsAOid,
      slug: "partial-preserve",
      sha: "sha-v2",
      sourceSha: "src-v1",
      entry: "custom.ts",
      status: "verified",
      now: tNew,
    });
    expect(partialUpdated.id).toBe(fullDef.id);
    expect(partialUpdated.sha).toBe("sha-v2");
    expect(partialUpdated.entry).toBe("custom.ts");
    expect(partialUpdated.spec).toEqual({ auth: "api_key" });
    expect(partialUpdated.entities).toEqual(["leads", "deals"]);
    expect(partialUpdated.hasIcon).toBe(true);
    expect(partialUpdated.lastCheckedAt).toEqual(tOld);
    expect(partialUpdated.build).toEqual({
      status: "built",
      hash: "bh1",
      bytes: 512,
      builtAt: tOld,
    });
    expect(partialUpdated.registry?.ref).toBe("@mako/crm");

    // #5: Stage 5 workspace-scoped canary in listWorkspaceIdsWithDueRetries
    const pastDue = new Date("2026-11-20T09:00:00.000Z");
    const checkNow = new Date("2026-11-20T10:00:00.000Z");
    await router.setDomainState({
      domain: "connections",
      workspaceId: wsAOid,
      mode: "pg_only",
    });
    // wsA (pg_only) has a due retry ONLY in PG; wsB (global mongo_only) has a due retry ONLY in Mongo
    await pgRepo.upsertConnectorDefinition({
      workspaceId: wsAOid,
      slug: "pg-only-retry",
      sha: "s1",
      sourceSha: "src1",
      status: "retrying",
      indexRetryAttempts: 1,
      nextIndexRetryAt: pastDue,
    });
    await mongoRepo.upsertConnectorDefinition({
      workspaceId: wsBOid,
      slug: "mongo-only-retry",
      sha: "s2",
      sourceSha: "src2",
      status: "retrying",
      indexRetryAttempts: 1,
      nextIndexRetryAt: pastDue,
    });
    // Also verify a stale Mongo retrying row for pg_only wsA is ignored when wsA has NO PG due retry
    const dueBoth = await dual.listWorkspaceIdsWithDueRetries(checkNow);
    expect(dueBoth.sort()).toEqual([wsAOid, wsBOid].sort());

    await pgRepo.deleteConnectorDefinition(wsAOid, "pg-only-retry");
    await mongoRepo.upsertConnectorDefinition({
      workspaceId: wsAOid,
      slug: "stale-mongo-retry-for-pg-only-ws",
      sha: "s3",
      sourceSha: "src3",
      status: "retrying",
      indexRetryAttempts: 1,
      nextIndexRetryAt: pastDue,
    });
    const dueAfterPgCleared =
      await dual.listWorkspaceIdsWithDueRetries(checkNow);
    expect(dueAfterPgCleared).toEqual([wsBOid]);

    // #6: Non-throwing invalid-ID guards + empty encryptedFields rollback in Mongo
    await expect(
      replayConnectionsWriteToPg(
        {
          target: "pg",
          domain: "connections",
          operation: "createDatabaseConnection",
          entityId: "not-a-valid-id",
          payload: { connectionId: "not-a-valid-id" },
          failedAt: new Date().toISOString(),
          errorMessage: "err",
        },
        db,
      ),
    ).resolves.toBeUndefined();
    const invalidWsVerify = await runParityVerification({
      domain: "connections",
      workspaceId: "not-a-valid-workspace-id",
      db,
    });
    expect(invalidWsVerify.ok).toBe(true);
    expect(invalidWsVerify.extraInPg).toBe(0);

    const emptyRollbackSrc = await mongoRepo.createSourceConnection({
      workspaceId: wsBOid,
      name: "Empty Rollback Fields",
      type: "stripe",
      config: { base_url: "https://api.stripe.com" },
      settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
      createdBy: nativeUserUuid,
      isActive: true,
    });
    expect(
      await mongoRepo.rollbackSourceConnectionKeyRequest({
        id: emptyRollbackSrc.id,
        workspaceId: wsBOid,
        encryptedFields: {},
        keyRequest: {
          tokenHash: sha256Hex("empty-rb-tok"),
          expiresAt: new Date(Date.now() + 60_000),
          fields: [],
          requestedBy: nativeUserUuid,
          createdAt: new Date(),
        },
      }),
    ).toBe(true);
  });
});

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
} from "../../database/pg/id-codec";
import { runPgliteMigrations } from "../../database/pg/migrate";
import * as pgSchema from "../../database/pg/schema";
import { createTestPglite } from "../../database/pg/test-pglite";
import {
  ConnectorDefinition,
  DatabaseConnection,
  SourceConnection,
} from "../../database/workspace-schema";
import { buildConsoleTemplate } from "../../databases/console-template";
import { encryptString, isEncryptedValue } from "../../services/crypto.service";
import { decryptConnectionObject, encryptConnectionObject } from "./crypto";
import { MongoConnectionsRepository } from "./mongo.repo";
import { PgConnectionsRepository } from "./pg.repo";
import {
  DATABASE_CONNECTION_TYPES,
  isDatabaseConnectionType,
  type ConnectionsRepository,
} from "./types";

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

  // ── 5. Secondary write failure isolation & bidirectional sync-retry ─────

  // ── 6. FK-ordered Backfill, Parity Verifier (--repair) & 90d TTL Reaper ─

  // ── 7. Verifier #69 hardening regressions (#1-#6) ──────────────────────

  // ── PR #1555 review-comment regressions (all 9 inline comments) ───────────

  it("PR #1555 #2 [4717225872]: buildConsoleTemplate accepts DatabaseConnectionRecord cleanly without any cast", async () => {
    const pgRepo = new PgConnectionsRepository({ getDb: () => db });
    const bq = await pgRepo.createDatabaseConnection({
      workspaceId: wsAOid,
      name: "BQ Warehouse",
      type: "bigquery",
      connection: { project_id: "acme-analytics" },
      createdBy: nativeUserUuid,
    });
    const bqTemplate = buildConsoleTemplate(bq, { id: "sales.orders" });
    expect(bqTemplate.language).toBe("sql");
    expect(bqTemplate.template).toBe(
      "SELECT * FROM `acme-analytics.sales.orders` LIMIT 500;",
    );

    const mongoDb = await pgRepo.createDatabaseConnection({
      workspaceId: wsAOid,
      name: "App Mongo",
      type: "mongodb",
      connection: { connectionString: "mongodb://localhost/app" },
      createdBy: nativeUserUuid,
    });
    const mongoTemplate = buildConsoleTemplate(mongoDb, {
      id: "users",
      kind: "collection",
    });
    expect(mongoTemplate.language).toBe("mongodb");
    expect(mongoTemplate.template).toContain('db.getCollection("users")');
  });

  it("PR #1555 #3 [4717279742]: configPatch merges changed keys atomically without erasing a concurrently claimed key-link secret", async () => {
    const mongoRepo = new MongoConnectionsRepository();
    const pgRepo = new PgConnectionsRepository({ getDb: () => db });

    for (const store of [mongoRepo, pgRepo] as const) {
      const tokenHash = sha256Hex(
        `key-link-race-token-${store === pgRepo ? "pg" : "mongo"}`,
      );
      const created = await store.createSourceConnection({
        workspaceId: wsAOid,
        name: "Awaiting Key",
        type: "stripe",
        config: { base_url: "https://old.example", account_id: "acct_old" },
        settings: { sync_batch_size: 100, rate_limit_delay_ms: 200 },
        createdBy: nativeUserUuid,
        isActive: false,
        keyRequest: {
          tokenHash,
          expiresAt: new Date(Date.now() + 60_000),
          fields: ["api_key"],
          requestedBy: nativeUserUuid,
          createdAt: new Date(),
        },
      });

      const encryptedKey = encryptString("sk_live_claimed_secret");
      expect(
        await store.claimSourceConnectionKeyRequest({
          id: created.id,
          workspaceId: wsAOid,
          tokenHash,
          encryptedFields: { api_key: encryptedKey },
        }),
      ).toBe(true);

      await store.updateSourceConnection(created.id, wsAOid, {
        configPatch: { account_id: "acct_new" },
      });

      const stored = await store.findSourceConnectionById(created.id, wsAOid);
      expect(stored?.isActive).toBe(true);
      expect(stored?.keyRequest).toBeUndefined();
      expect(stored?.config).toEqual({
        base_url: "https://old.example",
        account_id: "acct_new",
        api_key: encryptedKey,
      });

      await expect(
        store.updateSourceConnection(created.id, wsAOid, {
          config: {},
          configPatch: { account_id: "x" },
        }),
      ).rejects.toThrow(/cannot specify both/);
    }
  });

  it("PR #1555 #4 [4717280251]: updateConnectorDefinitionMetadata updates sha/entry/registry without overwriting concurrent status transitions", async () => {
    const mongoRepo = new MongoConnectionsRepository();
    const pgRepo = new PgConnectionsRepository({ getDb: () => db });

    const t0 = new Date("2026-11-25T10:00:00.000Z");
    const t1 = new Date("2026-11-25T10:01:00.000Z");
    const t2 = new Date("2026-11-25T10:02:00.000Z");

    for (const store of [mongoRepo, pgRepo] as const) {
      await store.upsertConnectorDefinition({
        workspaceId: wsAOid,
        slug: "crm",
        sha: "commit-1",
        sourceSha: "src-1",
        entry: "connector.ts",
        status: "indexed",
        now: t0,
      });

      expect(
        await store.recordConnectorDefinitionCheckResult(wsAOid, "crm", {
          ok: true,
          checkedAt: t1,
          expectedSourceSha: "src-1",
        }),
      ).toBe(true);

      expect(
        await store.updateConnectorDefinitionMetadata(wsAOid, "crm", {
          sha: "commit-2",
          entry: "index.ts",
          expectedSourceSha: "src-1",
          now: t2,
        }),
      ).toBe(true);

      const def = await store.findConnectorDefinition(wsAOid, "crm");
      expect(def?.sha).toBe("commit-2");
      expect(def?.entry).toBe("index.ts");
      expect(def?.status).toBe("verified");
      expect(def?.lastCheckedAt).toEqual(t1);

      expect(
        await store.recordConnectorDefinitionCheckResult(wsAOid, "crm", {
          ok: false,
          checkedAt: t2,
          expectedSourceSha: "src-1",
          error: "401 Unauthorized",
        }),
      ).toBe(true);

      expect(
        await store.updateConnectorDefinitionMetadata(wsAOid, "crm", {
          sha: "commit-3",
          expectedSourceSha: "src-1",
          registry: {
            ref: "mako/crm@1",
            slug: "crm",
            range: "^1.0.0",
            version: "1.0.0",
            hash: "h1",
            sha256: "s256",
            latest: "2.0.0",
            upgradeAvailable: "2.0.0",
            resolvedAt: t0,
          },
        }),
      ).toBe(true);

      const def2 = await store.findConnectorDefinition(wsAOid, "crm");
      expect(def2?.sha).toBe("commit-3");
      expect(def2?.status).toBe("indexed");
      expect(def2?.lastCheckError).toBe("401 Unauthorized");
      expect(def2?.registry?.upgradeAvailable).toBe("2.0.0");

      expect(
        await store.updateConnectorDefinitionMetadata(wsAOid, "crm", {
          sha: "stale-commit",
          expectedSourceSha: "src-wrong",
        }),
      ).toBe(false);
    }
  });

  it("PR #1555 #7 [4717281738]: rejects unknown DatabaseConnection.type before writing to Mongo or PG", async () => {
    const mongoRepo = new MongoConnectionsRepository();
    const pgRepo = new PgConnectionsRepository({ getDb: () => db });

    for (const validType of DATABASE_CONNECTION_TYPES) {
      expect(isDatabaseConnectionType(validType)).toBe(true);
    }
    expect(isDatabaseConnectionType("oracle")).toBe(false);
    expect(isDatabaseConnectionType("")).toBe(false);
    expect(isDatabaseConnectionType(null)).toBe(false);

    const invalidInput = {
      workspaceId: wsAOid,
      name: "Bad Oracle",
      type: "oracle" as unknown as (typeof DATABASE_CONNECTION_TYPES)[number],
      connection: { host: "oracle.internal" },
      createdBy: nativeUserUuid,
    };

    await expect(
      mongoRepo.createDatabaseConnection(invalidInput),
    ).rejects.toThrow(/Invalid database connection type: oracle/);
    await expect(pgRepo.createDatabaseConnection(invalidInput)).rejects.toThrow(
      /Invalid database connection type: oracle/,
    );

    expect(
      await DatabaseConnection.collection.countDocuments({
        name: "Bad Oracle",
      }),
    ).toBe(0);
    expect(await pgRepo.countDatabaseConnections(wsAOid)).toBe(0);
  });
});

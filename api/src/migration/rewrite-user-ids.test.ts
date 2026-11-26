/**
 * Tests for the Decision #3 User-ID Reference-Rewrite Tool:
 *   - Pure value, `user:<id>` principal, and writer-label rewriters
 *   - Loading `legacy_id -> uuid` map from Postgres `users`
 *   - MongoDB dry-run, apply, and idempotency across connections, ACLs, flows, dbt_runs, notifications, usage
 *   - Workspace git directory dry-run, apply, binary skipping, `users/<legacyId>/` rename, and idempotency
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MakoPgDb } from "../database/pg/client";
import { generateUuidv7, legacyUserIdToUuidv7 } from "../database/pg/id-codec";
import { runPgliteMigrations } from "../database/pg/migrate";
import * as pgSchema from "../database/pg/schema";
import { createTestPglite } from "../database/pg/test-pglite";
import {
  loadUserLegacyIdMap,
  rewriteGitUserIds,
  rewriteMongoUserIds,
  rewritePrincipalValue,
  rewriteTextFileUserIds,
  rewriteUserIdValue,
  rewriteWriterLabelValue,
} from "./rewrite-user-ids";

describe("User-ID reference rewrite tool (Decision #3)", () => {
  let mongo: MongoMemoryServer;
  let pg: PGlite;
  let db: MakoPgDb;

  const luciaId = "a1b2c3d4e5f6g7h";
  const legacyUuidv4 = "11111111-2222-4333-8444-555555555555";
  const nativeUuidv7 = generateUuidv7(Date.UTC(2026, 10, 26, 12, 0, 0));

  const luciaMapped = legacyUserIdToUuidv7(
    luciaId,
    new Date("2025-06-01T00:00:00.000Z"),
  );
  const v4Mapped = legacyUserIdToUuidv7(
    legacyUuidv4,
    new Date("2025-07-01T00:00:00.000Z"),
  );

  beforeAll(async () => {
    mongo = await MongoMemoryServer.create();
    await mongoose.connect(mongo.getUri());

    pg = createTestPglite();
    await runPgliteMigrations(pg);
    db = drizzle(pg, { schema: pgSchema }) as unknown as MakoPgDb;
  });

  beforeEach(async () => {
    await pg.exec("DELETE FROM users;");
    const mongoDb = mongoose.connection.db;
    if (!mongoDb) throw new Error("MongoDB test connection not initialized");
    const cols = await mongoDb
      .listCollections({}, { nameOnly: true })
      .toArray();
    for (const c of cols) {
      await mongoDb.collection(c.name).deleteMany({});
    }
  });

  afterAll(async () => {
    await mongoose.disconnect();
    await mongo.stop();
    await pg.close();
  });

  it("rewrites bare user IDs, user:<id> principals, and writer labels cleanly", () => {
    const map = new Map<string, string>([
      [luciaId, luciaMapped],
      [legacyUuidv4, v4Mapped],
    ]);

    expect(rewriteUserIdValue(luciaId, map)).toBe(luciaMapped);
    expect(rewriteUserIdValue("system", map)).toBeNull();
    expect(rewriteUserIdValue("anon:abc123", map)).toBeNull();
    expect(rewriteUserIdValue(nativeUuidv7, map)).toBeNull();

    expect(rewritePrincipalValue(`user:${luciaId}`, map)).toBe(
      `user:${luciaMapped}`,
    );
    expect(rewritePrincipalValue("workflow:daily", map)).toBeNull();
    expect(rewritePrincipalValue(`user:${luciaMapped}`, map)).toBeNull();

    expect(
      rewriteWriterLabelValue(`user:${luciaId} finance.invoices`, map),
    ).toBe(`user:${luciaMapped} finance.invoices`);
    expect(rewriteWriterLabelValue(`user:${legacyUuidv4}`, map)).toBe(
      `user:${v4Mapped}`,
    );
    expect(rewriteWriterLabelValue("workflow:* finance", map)).toBeNull();
  });

  it("loads only legacy_id <> id::text mappings from Postgres users", async () => {
    await db.insert(pgSchema.users).values([
      {
        id: luciaMapped,
        legacyId: luciaId,
        email: "lucia@example.com",
        emailVerified: true,
      },
      {
        id: v4Mapped,
        legacyId: legacyUuidv4,
        email: "v4@example.com",
        emailVerified: true,
      },
      {
        id: nativeUuidv7,
        legacyId: nativeUuidv7,
        email: "v7@example.com",
        emailVerified: true,
      },
      {
        id: generateUuidv7(),
        legacyId: null,
        email: "nulllegacy@example.com",
        emailVerified: true,
      },
    ]);

    const map = await loadUserLegacyIdMap(db);
    expect(map.size).toBe(2);
    expect(map.get(luciaId)).toBe(luciaMapped);
    expect(map.get(legacyUuidv4)).toBe(v4Mapped);
    expect(map.has(nativeUuidv7)).toBe(false);
  });

  it("dry-runs, applies, and stays idempotent across MongoDB collections", async () => {
    await db.insert(pgSchema.users).values([
      {
        id: luciaMapped,
        legacyId: luciaId,
        email: "lucia@example.com",
        emailVerified: true,
      },
      {
        id: v4Mapped,
        legacyId: legacyUuidv4,
        email: "v4@example.com",
        emailVerified: true,
      },
    ]);
    const userIdMap = await loadUserLegacyIdMap(db);
    const mongoDb = mongoose.connection.db;
    if (!mongoDb) throw new Error("MongoDB test connection not initialized");
    const wsId = new Types.ObjectId();

    await mongoDb.collection("databaseconnections").insertOne({
      _id: new Types.ObjectId(),
      workspaceId: wsId,
      name: "prod-pg",
      createdBy: luciaId,
      writers: [
        {
          principal: `user:${luciaId}`,
          where: "public",
          addedBy: legacyUuidv4,
        },
        { principal: "workflow:sync", addedBy: luciaId },
      ],
    });

    await mongoDb.collection("connectors").insertOne({
      _id: new Types.ObjectId(),
      workspaceId: wsId,
      name: "stripe",
      createdBy: luciaId,
      managers: [luciaId, legacyUuidv4],
      writers: [{ principal: `user:${legacyUuidv4}`, addedBy: luciaId }],
      liveReaders: [{ principal: `user:${luciaId}`, addedBy: legacyUuidv4 }],
      keyRequest: { requestedBy: luciaId, tokenHash: "h" },
    });

    await mongoDb.collection("connection_access_events").insertOne({
      _id: new Types.ObjectId(),
      workspaceId: wsId,
      actor: luciaId,
      changes: {
        writers: {
          added: [`user:${luciaId} finance.invoices`, "workflow:*"],
          removed: [`user:${legacyUuidv4}`],
        },
        managers: { added: [legacyUuidv4], removed: [] },
      },
    });

    await mongoDb.collection("savedconsoles").insertOne({
      _id: new Types.ObjectId(),
      workspaceId: wsId,
      createdBy: luciaId,
      owner_id: luciaId,
      sharedWith: [
        { userId: legacyUuidv4, access: "editor", addedBy: luciaId },
      ],
      publicShare: { token: "t", createdBy: luciaId },
    });

    await mongoDb.collection("flows").insertOne({
      _id: new Types.ObjectId(),
      workspaceId: wsId,
      createdBy: luciaId,
    });

    await mongoDb.collection("dbt_runs").insertOne({
      _id: new Types.ObjectId(),
      workspaceId: wsId,
      triggeredBy: luciaId,
      cancelledBy: legacyUuidv4,
      workingTreeUserId: luciaId,
      actor: { kind: "user", userId: luciaId, userName: "lucia" },
    });

    await mongoDb.collection("notification_rules").insertOne({
      _id: new Types.ObjectId(),
      workspaceId: wsId,
      createdBy: legacyUuidv4,
    });

    await mongoDb.collection("app_usage_daily").insertMany([
      { workspaceId: wsId, appId: "a1", userId: luciaId, day: "2026-11-25" },
      {
        workspaceId: wsId,
        appId: "a1",
        userId: "anon:hash123",
        day: "2026-11-25",
      },
      { workspaceId: wsId, appId: "a1", userId: null, day: "2026-11-25" },
    ]);

    // 1. Dry-run (default) scans and counts WITHOUT mutating MongoDB
    const dryReport = await rewriteMongoUserIds({ mongoDb, userIdMap });
    expect(dryReport.dryRun).toBe(true);
    expect(dryReport.totalMatchedDocs).toBe(8);
    expect(dryReport.totalModifiedDocs).toBe(0);
    expect(dryReport.totalFieldsRewritten).toBeGreaterThanOrEqual(20);
    expect((await mongoDb.collection("flows").findOne({}))?.createdBy).toBe(
      luciaId,
    );

    // 2. Apply rewrites
    const applyReport = await rewriteMongoUserIds({
      mongoDb,
      userIdMap,
      dryRun: false,
    });
    expect(applyReport.dryRun).toBe(false);
    expect(applyReport.totalModifiedDocs).toBe(8);

    const dbConn = await mongoDb.collection("databaseconnections").findOne({});
    expect(dbConn?.createdBy).toBe(luciaMapped);
    expect(dbConn?.writers).toEqual([
      { principal: `user:${luciaMapped}`, where: "public", addedBy: v4Mapped },
      { principal: "workflow:sync", addedBy: luciaMapped },
    ]);

    const connector = await mongoDb.collection("connectors").findOne({});
    expect(connector?.createdBy).toBe(luciaMapped);
    expect(connector?.managers).toEqual([luciaMapped, v4Mapped]);
    expect(connector?.writers).toEqual([
      { principal: `user:${v4Mapped}`, addedBy: luciaMapped },
    ]);
    expect(connector?.liveReaders).toEqual([
      { principal: `user:${luciaMapped}`, addedBy: v4Mapped },
    ]);
    expect(connector?.keyRequest.requestedBy).toBe(luciaMapped);

    const accessEvt = await mongoDb
      .collection("connection_access_events")
      .findOne({});
    expect(accessEvt?.actor).toBe(luciaMapped);
    expect(accessEvt?.changes.writers.added).toEqual([
      `user:${luciaMapped} finance.invoices`,
      "workflow:*",
    ]);
    expect(accessEvt?.changes.writers.removed).toEqual([`user:${v4Mapped}`]);
    expect(accessEvt?.changes.managers.added).toEqual([v4Mapped]);

    const consoleDoc = await mongoDb.collection("savedconsoles").findOne({});
    expect(consoleDoc?.createdBy).toBe(luciaMapped);
    expect(consoleDoc?.owner_id).toBe(luciaMapped);
    expect(consoleDoc?.sharedWith).toEqual([
      { userId: v4Mapped, access: "editor", addedBy: luciaMapped },
    ]);
    expect(consoleDoc?.publicShare.createdBy).toBe(luciaMapped);

    const dbtRun = await mongoDb.collection("dbt_runs").findOne({});
    expect(dbtRun?.triggeredBy).toBe(luciaMapped);
    expect(dbtRun?.cancelledBy).toBe(v4Mapped);
    expect(dbtRun?.workingTreeUserId).toBe(luciaMapped);
    expect(dbtRun?.actor.userId).toBe(luciaMapped);

    expect((await mongoDb.collection("flows").findOne({}))?.createdBy).toBe(
      luciaMapped,
    );
    expect(
      (await mongoDb.collection("notification_rules").findOne({}))?.createdBy,
    ).toBe(v4Mapped);

    // Anonymous and null usage records stay untouched
    const usageDocs = await mongoDb
      .collection("app_usage_daily")
      .find({})
      .toArray();
    expect(usageDocs.map(d => d.userId).sort()).toEqual(
      [luciaMapped, "anon:hash123", null].sort(),
    );

    // 3. Re-running is a strict idempotent no-op
    const rerun = await rewriteMongoUserIds({
      mongoDb,
      userIdMap,
      dryRun: false,
    });
    expect(rerun.totalMatchedDocs).toBe(0);
    expect(rerun.totalModifiedDocs).toBe(0);
    expect(rerun.totalFieldsRewritten).toBe(0);
  });

  it("rewrites workspace git files and legacy users/<id> directories idempotently", async () => {
    const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-git-rewrite-"));
    try {
      const userIdMap = new Map<string, string>([
        [luciaId, luciaMapped],
        [legacyUuidv4, v4Mapped],
      ]);

      // Seed files: YAML, JSON, binary PNG, .git metadata, and legacy users/<luciaId>/ folder
      fs.mkdirSync(path.join(tmpDir, ".git"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, ".git", "config"),
        `ownerId: ${luciaId}\n`,
      );
      fs.mkdirSync(path.join(tmpDir, "dbt"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "dbt", "environments.yml"),
        [
          "environments:",
          "  - name: personal",
          `    ownerUserId: ${luciaId}`,
          `    writers: ["user:${luciaId}", "user:${legacyUuidv4}", "workflow:nightly"]`,
        ].join("\n"),
      );
      fs.mkdirSync(path.join(tmpDir, "apps", "revenue"), { recursive: true });
      fs.writeFileSync(
        path.join(tmpDir, "apps", "revenue", "mako.app.json"),
        JSON.stringify(
          {
            title: "Revenue",
            ownerId: luciaId,
            createdBy: legacyUuidv4,
            note: `not-a-match-${luciaId}-suffix`,
          },
          null,
          2,
        ),
      );
      // Binary file should be skipped
      fs.writeFileSync(
        path.join(tmpDir, "apps", "revenue", "thumbnail.png"),
        Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01]),
      );
      // Legacy `users/<luciaId>/` folder
      fs.mkdirSync(path.join(tmpDir, "users", luciaId, "apps"), {
        recursive: true,
      });
      fs.writeFileSync(
        path.join(tmpDir, "users", luciaId, "apps", "notes.yaml"),
        `owner_id: "${luciaId}"\n`,
      );

      // 1. Dry-run makes zero filesystem mutations
      const dryReport = await rewriteGitUserIds({
        repoDir: tmpDir,
        userIdMap,
        dryRun: true,
      });
      expect(dryReport.filesMatched).toBe(3);
      expect(dryReport.filesModified).toBe(0);
      expect(dryReport.totalReplacements).toBe(6);
      expect(dryReport.directoryRenames).toEqual([
        { from: `users/${luciaId}`, to: `users/${luciaMapped}` },
      ]);
      expect(fs.existsSync(path.join(tmpDir, "users", luciaId))).toBe(true);

      // 2. Apply modifies text files & renames legacy folder, skipping .git and binaries
      const applyReport = await rewriteGitUserIds({
        repoDir: tmpDir,
        userIdMap,
        dryRun: false,
      });
      expect(applyReport.filesModified).toBe(3);
      expect(applyReport.totalReplacements).toBe(6);

      // .git/config MUST NOT be touched
      expect(
        fs.readFileSync(path.join(tmpDir, ".git", "config"), "utf8"),
      ).toContain(luciaId);

      const envYaml = fs.readFileSync(
        path.join(tmpDir, "dbt", "environments.yml"),
        "utf8",
      );
      expect(envYaml).toContain(`ownerUserId: ${luciaMapped}`);
      expect(envYaml).toContain(`user:${luciaMapped}`);
      expect(envYaml).toContain(`user:${v4Mapped}`);
      expect(envYaml).toContain("workflow:nightly");

      const appJson = JSON.parse(
        fs.readFileSync(
          path.join(tmpDir, "apps", "revenue", "mako.app.json"),
          "utf8",
        ),
      );
      expect(appJson.ownerId).toBe(luciaMapped);
      expect(appJson.createdBy).toBe(v4Mapped);
      // Arbitrary substring in prose is NOT corrupted
      expect(appJson.note).toBe(`not-a-match-${luciaId}-suffix`);

      // Legacy folder renamed cleanly
      expect(fs.existsSync(path.join(tmpDir, "users", luciaId))).toBe(false);
      expect(
        fs.readFileSync(
          path.join(tmpDir, "users", luciaMapped, "apps", "notes.yaml"),
          "utf8",
        ),
      ).toBe(`owner_id: "${luciaMapped}"\n`);

      // 3. Re-running is strictly idempotent
      const rerun = await rewriteGitUserIds({
        repoDir: tmpDir,
        userIdMap,
        dryRun: false,
      });
      expect(rerun.filesMatched).toBe(0);
      expect(rerun.filesModified).toBe(0);
      expect(rerun.totalReplacements).toBe(0);
      expect(rerun.directoryRenames).toEqual([]);

      // Pure helper boundary check
      expect(
        rewriteTextFileUserIds(`principal: user:${luciaId}extra`, userIdMap),
      ).toEqual({
        content: `principal: user:${luciaId}extra`,
        replacements: 0,
      });
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });
});

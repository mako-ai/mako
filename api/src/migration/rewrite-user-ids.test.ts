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
  MONGO_USER_ID_REWRITE_SPECS,
  assertAuthStageAllowsRewriteApply,
  loadUserLegacyIdMap,
  rewriteGitUserIds,
  rewriteMongoUserIds,
  rewritePrincipalValue,
  rewriteTextFileUserIds,
  rewriteUserIdValue,
  rewriteWriterLabelValue,
} from "./rewrite-user-ids";
import { MigrationRouter } from "./router";

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
    await pg.exec("DELETE FROM users; DELETE FROM migration_domain_state;");
    const mongoDb = mongoose.connection.db;
    if (!mongoDb) throw new Error("MongoDB test connection not initialized");
    const cols = await mongoDb
      .listCollections({}, { nameOnly: true })
      .toArray();
    for (const c of cols) {
      await mongoDb
        .collection(c.name)
        .drop()
        .catch(() => undefined);
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

    // Fixed Mongoose pluralized collection names + added user-ID collections (#41)
    await mongoDb.collection("mcpoauthcodes").insertOne({
      _id: new Types.ObjectId(),
      userId: luciaId,
    });
    await mongoDb.collection("mcpoauthtokens").insertOne({
      _id: new Types.ObjectId(),
      userId: legacyUuidv4,
    });
    await mongoDb.collection("mcp_connection_configs").insertOne({
      _id: new Types.ObjectId(),
      userId: luciaId,
    });
    await mongoDb.collection("mcp_oauth_flows").insertOne({
      _id: new Types.ObjectId(),
      configUserId: luciaId,
      startedByUserId: legacyUuidv4,
    });
    await mongoDb.collection("acpplangrants").insertOne({
      _id: new Types.ObjectId(),
      userId: luciaId,
    });
    await mongoDb.collection("workflow_recorded_writes").insertOne({
      _id: new Types.ObjectId(),
      userId: legacyUuidv4,
    });
    await mongoDb.collection("notebookfolders").insertOne({
      _id: new Types.ObjectId(),
      ownerId: luciaId,
    });
    await mongoDb.collection("notebookindexes").insertOne({
      _id: new Types.ObjectId(),
      ownerId: luciaId,
      sharedWith: [{ userId: legacyUuidv4, addedBy: luciaId }],
    });
    await mongoDb.collection("llmusages").insertOne({
      _id: new Types.ObjectId(),
      userId: luciaId,
    });
    await mongoDb.collection("chatattachments").insertOne({
      _id: new Types.ObjectId(),
      createdBy: legacyUuidv4,
    });
    await mongoDb.collection("app_binding_jobs").insertOne({
      _id: new Types.ObjectId(),
      actorId: luciaId,
      userId: legacyUuidv4,
    });
    await mongoDb.collection("realtime_presence").insertOne({
      _id: new Types.ObjectId(),
      userId: luciaId,
    });

    // 1. Dry-run (default) scans and counts WITHOUT mutating MongoDB
    const dryReport = await rewriteMongoUserIds({ mongoDb, userIdMap });
    expect(dryReport.dryRun).toBe(true);
    expect(dryReport.totalMatchedDocs).toBe(20);
    expect(dryReport.totalModifiedDocs).toBe(0);
    expect(dryReport.totalFieldsRewritten).toBeGreaterThanOrEqual(35);
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
    expect(applyReport.totalModifiedDocs).toBe(20);

    // Verify fixed & newly added collections were rewritten cleanly
    expect(
      (await mongoDb.collection("mcpoauthcodes").findOne({}))?.userId,
    ).toBe(luciaMapped);
    expect(
      (await mongoDb.collection("mcpoauthtokens").findOne({}))?.userId,
    ).toBe(v4Mapped);
    expect(
      (await mongoDb.collection("mcp_connection_configs").findOne({}))?.userId,
    ).toBe(luciaMapped);
    const oauthFlow = await mongoDb.collection("mcp_oauth_flows").findOne({});
    expect(oauthFlow?.configUserId).toBe(luciaMapped);
    expect(oauthFlow?.startedByUserId).toBe(v4Mapped);
    expect(
      (await mongoDb.collection("acpplangrants").findOne({}))?.userId,
    ).toBe(luciaMapped);
    expect(
      (await mongoDb.collection("workflow_recorded_writes").findOne({}))
        ?.userId,
    ).toBe(v4Mapped);
    expect(
      (await mongoDb.collection("notebookfolders").findOne({}))?.ownerId,
    ).toBe(luciaMapped);
    const nbIndex = await mongoDb.collection("notebookindexes").findOne({});
    expect(nbIndex?.ownerId).toBe(luciaMapped);
    expect(nbIndex?.sharedWith).toEqual([
      { userId: v4Mapped, addedBy: luciaMapped },
    ]);
    expect((await mongoDb.collection("llmusages").findOne({}))?.userId).toBe(
      luciaMapped,
    );
    expect(
      (await mongoDb.collection("chatattachments").findOne({}))?.createdBy,
    ).toBe(v4Mapped);
    const bindingJob = await mongoDb.collection("app_binding_jobs").findOne({});
    expect(bindingJob?.actorId).toBe(luciaMapped);
    expect(bindingJob?.userId).toBe(v4Mapped);
    expect(
      (await mongoDb.collection("realtime_presence").findOne({}))?.userId,
    ).toBe(luciaMapped);

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

      // YAML list-item mapping keys (`- userId: ...`) must also be rewritten cleanly (#41)
      const yamlListInput = [
        "sharedWith:",
        `  - userId: ${luciaId}`,
        `    addedBy: ${legacyUuidv4}`,
        `  - userId: "${legacyUuidv4}"`,
      ].join("\n");
      const yamlListResult = rewriteTextFileUserIds(yamlListInput, userIdMap);
      expect(yamlListResult.replacements).toBe(3);
      expect(yamlListResult.content).toBe(
        [
          "sharedWith:",
          `  - userId: ${luciaMapped}`,
          `    addedBy: ${v4Mapped}`,
          `  - userId: "${v4Mapped}"`,
        ].join("\n"),
      );
      expect(rewriteTextFileUserIds(yamlListResult.content, userIdMap)).toEqual(
        {
          content: yamlListResult.content,
          replacements: 0,
        },
      );
    } finally {
      fs.rmSync(tmpDir, { recursive: true, force: true });
    }
  });

  it("matches every MONGO_USER_ID_REWRITE_SPECS collection against a real registered Mongoose model", async () => {
    await Promise.all([
      import("../database/schema"),
      import("../database/workspace-schema"),
      import("../database/acp-plan-grant-schema"),
      import("../database/mcp-oauth-schema"),
      import("../access/connection-access-event"),
      import("../access/connection-write-event"),
      import("../apps/binding-jobs"),
      import("../workflows/recorded-writes"),
    ]);

    const registeredCollections = new Set(
      mongoose
        .modelNames()
        .map(name => mongoose.model(name).collection.collectionName),
    );
    const seenSpecs = new Set<string>();
    const missingCollections: string[] = [];

    for (const spec of MONGO_USER_ID_REWRITE_SPECS) {
      expect(seenSpecs.has(spec.collection)).toBe(false);
      seenSpecs.add(spec.collection);
      if (!registeredCollections.has(spec.collection)) {
        missingCollections.push(spec.collection);
      }
    }

    expect(missingCollections).toEqual([]);
  });

  // ── PR #1553 review regression tests ────────────────────────────────────

  it("rewrites savedconsoles.lastRun.runBy, workspaces.appsRepo.linkedBy, and workspaces.workspaceRepos[].linkedBy (#4717225841)", async () => {
    const userIdMap = new Map<string, string>([
      [luciaId, luciaMapped],
      [legacyUuidv4, v4Mapped],
    ]);
    const mongoDb = mongoose.connection.db;
    if (!mongoDb) throw new Error("MongoDB test connection not initialized");
    const wsId = new Types.ObjectId();

    await mongoDb.collection("savedconsoles").insertOne({
      _id: new Types.ObjectId(),
      workspaceId: wsId,
      createdBy: luciaMapped,
      owner_id: luciaMapped,
      lastRun: {
        at: new Date("2026-11-26T10:00:00.000Z"),
        status: "success",
        durationMs: 42,
        runBy: luciaId,
        source: "editor",
      },
    });

    await mongoDb.collection("workspaces").insertOne({
      _id: wsId,
      name: "Acme",
      createdBy: luciaId,
      appsRepo: {
        provider: "github",
        owner: "acme",
        repo: "apps",
        defaultBranch: "main",
        subdirectory: "",
        linkedBy: luciaId,
      },
      workspaceRepos: [
        {
          provider: "github",
          owner: "acme",
          repo: "repo-1",
          defaultBranch: "main",
          subdirectory: "",
          linkedBy: luciaId,
        },
        {
          provider: "github",
          owner: "acme",
          repo: "repo-2",
          defaultBranch: "main",
          subdirectory: "analytics",
          linkedBy: legacyUuidv4,
        },
      ],
      apiKeys: [{ name: "ci", keyHash: "h", prefix: "mk", createdBy: luciaId }],
    });

    const dry = await rewriteMongoUserIds({ mongoDb, userIdMap, dryRun: true });
    expect(dry.totalMatchedDocs).toBe(2);
    expect(dry.totalFieldsRewritten).toBe(6);

    const applied = await rewriteMongoUserIds({
      mongoDb,
      userIdMap,
      dryRun: false,
    });
    expect(applied.totalModifiedDocs).toBe(2);
    expect(applied.totalFieldsRewritten).toBe(6);

    const consoleDoc = await mongoDb.collection("savedconsoles").findOne({});
    expect(consoleDoc?.lastRun?.runBy).toBe(luciaMapped);

    const wsDoc = await mongoDb.collection("workspaces").findOne({ _id: wsId });
    expect(wsDoc?.createdBy).toBe(luciaMapped);
    expect(wsDoc?.appsRepo?.linkedBy).toBe(luciaMapped);
    expect(wsDoc?.workspaceRepos).toMatchObject([
      { repo: "repo-1", linkedBy: luciaMapped },
      { repo: "repo-2", linkedBy: v4Mapped },
    ]);
    expect(wsDoc?.apiKeys?.[0]?.createdBy).toBe(luciaMapped);

    // Strictly idempotent on re-run
    const rerun = await rewriteMongoUserIds({
      mongoDb,
      userIdMap,
      dryRun: false,
    });
    expect(rerun.totalMatchedDocs).toBe(0);
    expect(rerun.totalModifiedDocs).toBe(0);
  });

  it("handles E11000 duplicate-key collisions per doc without aborting and merges app_usage_daily + workspacemembers cleanly (#4717225455)", async () => {
    const userIdMap = new Map<string, string>([
      [luciaId, luciaMapped],
      [legacyUuidv4, v4Mapped],
    ]);
    const mongoDb = mongoose.connection.db;
    if (!mongoDb) throw new Error("MongoDB test connection not initialized");

    const ws1 = new Types.ObjectId();
    const ws2 = new Types.ObjectId();
    const tEarly = new Date("2026-11-26T08:00:00.000Z");
    const tLate = new Date("2026-11-26T16:00:00.000Z");

    // Create the real unique indexes that trigger E11000 after flipping to Stage 4
    await mongoDb
      .collection("app_usage_daily")
      .createIndex(
        { workspaceId: 1, appId: 1, userId: 1, day: 1 },
        { unique: true },
      );
    await mongoDb
      .collection("workspacemembers")
      .createIndex({ workspaceId: 1, userId: 1 }, { unique: true });
    await mongoDb.collection("workspacemembers").createIndex(
      { userId: 1, isDefaultMembership: 1 },
      {
        unique: true,
        partialFilterExpression: { isDefaultMembership: true },
      },
    );
    await mongoDb
      .collection("app_worktrees")
      .createIndex({ workspaceId: 1, userId: 1 }, { unique: true });
    await mongoDb
      .collection("workspace_user_handles")
      .createIndex({ workspaceId: 1, userId: 1 }, { unique: true });

    // 1. app_usage_daily duplicate: live UUIDv7 row + stale legacy row on same day
    await mongoDb.collection("app_usage_daily").insertMany([
      {
        _id: new Types.ObjectId(),
        workspaceId: ws1,
        appId: "rev-app",
        userId: luciaId,
        day: "2026-11-26",
        opens: 3,
        activeSeconds: 120,
        sources: { app: 2, share: 1 },
        firstAt: tEarly,
        lastAt: new Date("2026-11-26T10:00:00.000Z"),
      },
      {
        _id: new Types.ObjectId(),
        workspaceId: ws1,
        appId: "rev-app",
        userId: luciaMapped,
        day: "2026-11-26",
        opens: 5,
        activeSeconds: 300,
        sources: { app: 4, embed: 1 },
        firstAt: new Date("2026-11-26T12:00:00.000Z"),
        lastAt: tLate,
      },
    ]);

    // 2. workspacemembers same-workspace duplicate (legacy has higher role "owner" vs live "member")
    //    + cross-workspace partial unique default-membership collision
    await mongoDb.collection("workspacemembers").insertMany([
      {
        _id: new Types.ObjectId(),
        workspaceId: ws1,
        userId: luciaId,
        role: "owner",
        joinedAt: tEarly,
      },
      {
        _id: new Types.ObjectId(),
        workspaceId: ws1,
        userId: luciaMapped,
        role: "member",
        joinedAt: tLate,
      },
      {
        _id: new Types.ObjectId(),
        workspaceId: ws1,
        userId: legacyUuidv4,
        role: "owner",
        joinedAt: tEarly,
        isDefaultMembership: true,
      },
      {
        _id: new Types.ObjectId(),
        workspaceId: ws2,
        userId: v4Mapped,
        role: "owner",
        joinedAt: tLate,
        isDefaultMembership: true,
      },
    ]);

    // 3. app_worktrees & workspace_user_handles duplicates
    await mongoDb.collection("app_worktrees").insertMany([
      { _id: new Types.ObjectId(), workspaceId: ws1, userId: luciaId },
      { _id: new Types.ObjectId(), workspaceId: ws1, userId: luciaMapped },
    ]);
    await mongoDb.collection("workspace_user_handles").insertMany([
      {
        _id: new Types.ObjectId(),
        workspaceId: ws1,
        userId: luciaId,
        handle: "lucia-old",
      },
      {
        _id: new Types.ObjectId(),
        workspaceId: ws1,
        userId: luciaMapped,
        handle: "lucia",
      },
    ]);

    // 4. Subsequent collection (flows) must STILL be processed after collisions!
    await mongoDb.collection("flows").insertOne({
      _id: new Types.ObjectId(),
      workspaceId: ws1,
      createdBy: luciaId,
    });

    const report = await rewriteMongoUserIds({
      mongoDb,
      userIdMap,
      dryRun: false,
    });

    expect(report.totalConflictsResolved).toBe(5);
    expect(report.totalConflictsSkipped).toBe(0);
    expect(report.conflicts).toHaveLength(5);
    expect(report.conflicts.every(c => c.kind === "duplicate_key")).toBe(true);

    // app_usage_daily counters merged losslessly into the UUIDv7 row
    const usageRows = await mongoDb
      .collection("app_usage_daily")
      .find({})
      .toArray();
    expect(usageRows).toHaveLength(1);
    expect(usageRows[0]).toMatchObject({
      userId: luciaMapped,
      opens: 8,
      activeSeconds: 420,
      sources: { app: 6, share: 1, embed: 1 },
      firstAt: tEarly,
      lastAt: tLate,
    });

    // workspacemembers preserved higher role ("owner") & earlier joinedAt AND kept cross-workspace membership!
    const luciaMemberships = await mongoDb
      .collection("workspacemembers")
      .find({ workspaceId: ws1, userId: luciaMapped })
      .toArray();
    expect(luciaMemberships).toHaveLength(1);
    expect(luciaMemberships[0].role).toBe("owner");
    expect(luciaMemberships[0].joinedAt).toEqual(tEarly);

    const v4Memberships = await mongoDb
      .collection("workspacemembers")
      .find({ userId: v4Mapped })
      .toArray();
    expect(v4Memberships).toHaveLength(2);
    const v4Ws1 = v4Memberships.find(
      m => String(m.workspaceId) === String(ws1),
    );
    expect(v4Ws1?.isDefaultMembership).toBeUndefined();

    // app_worktrees & workspace_user_handles have only the live UUIDv7 row left
    expect(
      await mongoDb.collection("app_worktrees").find({}).toArray(),
    ).toHaveLength(1);
    expect(
      await mongoDb.collection("workspace_user_handles").find({}).toArray(),
    ).toHaveLength(1);

    // Later collections were NOT aborted
    expect((await mongoDb.collection("flows").findOne({}))?.createdBy).toBe(
      luciaMapped,
    );

    // Re-running is strictly idempotent with 0 conflicts
    const rerun = await rewriteMongoUserIds({
      mongoDb,
      userIdMap,
      dryRun: false,
    });
    expect(rerun.totalMatchedDocs).toBe(0);
    expect(rerun.totalConflictsResolved).toBe(0);
    expect(rerun.conflicts).toEqual([]);
  });

  it("guards updates against concurrent live edits so revoked shares/managers are never overwritten (#4717225455)", async () => {
    const userIdMap = new Map<string, string>([
      [luciaId, luciaMapped],
      [legacyUuidv4, v4Mapped],
    ]);
    const mongoDb = mongoose.connection.db;
    if (!mongoDb) throw new Error("MongoDB test connection not initialized");
    const wsId = new Types.ObjectId();

    const consoleId = new Types.ObjectId();
    await mongoDb.collection("savedconsoles").insertOne({
      _id: consoleId,
      workspaceId: wsId,
      createdBy: luciaMapped,
      owner_id: luciaMapped,
      sharedWith: [
        { userId: luciaId, access: "editor", addedBy: luciaId },
        { userId: "revoked-user-id", access: "editor", addedBy: luciaId },
      ],
    });

    const connectorId = new Types.ObjectId();
    await mongoDb.collection("connectors").insertOne({
      _id: connectorId,
      workspaceId: wsId,
      createdBy: luciaMapped,
      managers: [luciaId, "revoked-manager-id"],
      writers: [
        { principal: `user:${luciaId}`, addedBy: luciaId },
        { principal: "user:revoked-writer-id", addedBy: luciaId },
      ],
    });

    let consoleAttempts = 0;
    let connectorAttempts = 0;

    const report = await rewriteMongoUserIds({
      mongoDb,
      userIdMap,
      dryRun: false,
      beforeDocUpdate: async ({ collection, docId, attempt }) => {
        if (collection === "savedconsoles" && attempt === 0) {
          consoleAttempts += 1;
          // Concurrent admin revokes `revoked-user-id` and adds `fresh-share-id`
          await mongoDb.collection("savedconsoles").updateOne(
            { _id: docId as never },
            {
              $set: {
                sharedWith: [
                  { userId: luciaId, access: "editor", addedBy: luciaId },
                  {
                    userId: "fresh-share-id",
                    access: "viewer",
                    addedBy: luciaMapped,
                  },
                ],
              },
            },
          );
        }
        if (collection === "connectors" && attempt === 0) {
          connectorAttempts += 1;
          // Concurrent admin revokes `revoked-manager-id` and `revoked-writer-id`
          await mongoDb.collection("connectors").updateOne(
            { _id: docId as never },
            {
              $set: {
                managers: [luciaId],
                writers: [{ principal: `user:${luciaId}`, addedBy: luciaId }],
              },
            },
          );
        }
      },
    });

    expect(consoleAttempts).toBe(1);
    expect(connectorAttempts).toBe(1);
    expect(report.totalModifiedDocs).toBe(2);
    expect(report.totalConflictsSkipped).toBe(0);

    // Revoked entries stay revoked, newly added share is preserved, and legacy IDs are rewritten!
    const updatedConsole = await mongoDb
      .collection("savedconsoles")
      .findOne({ _id: consoleId });
    expect(updatedConsole?.sharedWith).toEqual([
      { userId: luciaMapped, access: "editor", addedBy: luciaMapped },
      { userId: "fresh-share-id", access: "viewer", addedBy: luciaMapped },
    ]);

    const updatedConnector = await mongoDb
      .collection("connectors")
      .findOne({ _id: connectorId });
    expect(updatedConnector?.managers).toEqual([luciaMapped]);
    expect(updatedConnector?.writers).toEqual([
      { principal: `user:${luciaMapped}`, addedBy: luciaMapped },
    ]);

    // Exhausting retries reports a skipped concurrent_modification conflict cleanly without aborting
    const busyId = new Types.ObjectId();
    await mongoDb.collection("connectors").insertOne({
      _id: busyId,
      workspaceId: wsId,
      createdBy: luciaMapped,
      managers: [luciaId, "v0"],
    });
    const busyReport = await rewriteMongoUserIds({
      mongoDb,
      userIdMap,
      dryRun: false,
      collections: ["connectors"],
      maxRetriesPerDoc: 2,
      beforeDocUpdate: async ({ docId, attempt }) => {
        await mongoDb
          .collection("connectors")
          .updateOne(
            { _id: docId as never },
            { $set: { managers: [luciaId, `concurrent-${attempt}`] } },
          );
      },
    });
    expect(busyReport.totalConflictsSkipped).toBe(1);
    expect(busyReport.conflicts[0]).toMatchObject({
      collection: "connectors",
      kind: "concurrent_modification",
      resolution: "skipped",
    });
  });

  it("blocks applying rewrites unless auth domain is in Stage 4/5 unless --force is set (#4717226153)", async () => {
    const router = new MigrationRouter({
      enablePubSub: false,
      getDb: () => db,
      hasPg: () => true,
      isForceMongoOnly: () => false,
    });

    // Stages 1–3 MUST refuse without --force and allow only with --force
    for (const blockedMode of [
      "mongo_only",
      "dual_write_mongo_read",
      "dual_write_shadow_compare",
    ] as const) {
      await router.setDomainState({
        domain: "auth",
        mode: blockedMode,
        ...(blockedMode === "dual_write_shadow_compare"
          ? { shadowSampleRate: 0.1 }
          : {}),
      });
      await expect(
        assertAuthStageAllowsRewriteApply({ router }),
      ).rejects.toThrow(new RegExp(blockedMode));
      await expect(
        assertAuthStageAllowsRewriteApply({ router, force: true }),
      ).resolves.toMatchObject({ mode: blockedMode });
    }

    // Stages 4–5 MUST allow without --force
    for (const allowedMode of ["dual_write_pg_read", "pg_only"] as const) {
      await router.setDomainState({ domain: "auth", mode: allowedMode });
      await expect(
        assertAuthStageAllowsRewriteApply({ router }),
      ).resolves.toMatchObject({ mode: allowedMode });
    }
  });

  it("throws an explicit error on unknown --collections names instead of silently reporting 0 matches (#4717228124)", async () => {
    const mongoDb = mongoose.connection.db;
    if (!mongoDb) throw new Error("MongoDB test connection not initialized");
    const userIdMap = new Map<string, string>([[luciaId, luciaMapped]]);

    await expect(
      rewriteMongoUserIds({
        mongoDb,
        userIdMap,
        collections: ["workspace_members"],
      }),
    ).rejects.toThrow(/Unknown --collections name\(s\): workspace_members/);

    // Must ALSO reject unknown collection names even when userIdMap is empty
    await expect(
      rewriteMongoUserIds({
        mongoDb,
        userIdMap: new Map(),
        collections: ["workspacemembers", "not_a_real_collection"],
      }),
    ).rejects.toThrow(/Unknown --collections name\(s\): not_a_real_collection/);
  });
});

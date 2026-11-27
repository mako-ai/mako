/**
 * Phase 3 (Part 1) `mcp` domain repository & migration contract test suite.
 *
 * Covers:
 *   - 0007_phase3_mcp schema constraints (4 tables, `UNIQUE NULLS NOT DISTINCT`
 *     for workspace-shared `user_id IS NULL` vs per-user configs, ON DELETE CASCADE).
 *   - `MongoMcpRepository`, `PgMcpRepository`, and `DualMcpRepository` across
 *     all 5 `MigrationMode` stages + instant Stage 4 -> Stage 2 rollback.
 *   - Opaque encrypted blob fidelity & redaction of all 4 encrypted fields in `shadow-compare`.
 *   - `mcp_oauth_flows` 10-minute read-time SQL guard, hourly TTL reaper, skipped backfill,
 *     and Stage 4 10m PG -> Mongo read-fallback for in-flight OAuth flows.
 *   - Resumable FK-ordered backfill (`mcp_servers` -> `mcp_connection_configs` -> `mcp_tool_grants`),
 *     orphan quarantine, delete tombstones, parity verifier, and `--repair`.
 */
import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as drizzlePgliteMigrate } from "drizzle-orm/pglite/migrator";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose, { Types } from "mongoose";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import {
  McpConnectionConfig,
  McpOAuthFlow,
  McpServer,
  McpToolGrant,
} from "../../database/models/mcp";
import {
  resetPgTestDb,
  setPgTestDb,
  type MakoPgDb,
} from "../../database/pg/client";
import {
  generateUuidv7,
  newDualId,
  objectIdToUuid,
} from "../../database/pg/id-codec";
import { resolveMigrationsFolder } from "../../database/pg/migrate";
import * as schema from "../../database/pg/schema";
import { createTestPglite } from "../../database/pg/test-pglite";
import {
  clearSyncRetryHandlersForTests,
  getSyncRetryHandler,
} from "../../inngest/functions/migration/sync-retry";
import {
  clearBackfillRegistryForTests,
  runBackfill,
} from "../../migration/backfill";
import { registerMcpMigrationDomain } from "../../migration/domains/mcp.backfill";
import { MigrationRouter } from "../../migration/router";
import {
  computeDiffPaths,
  ShadowCompareRunner,
  type ShadowCompareEvent,
} from "../../migration/shadow-compare";
import {
  clearTtlRegistryForTests,
  listTtlRules,
  reapExpiredRows,
} from "../../migration/ttl-reaper";
import {
  clearVerifierRegistryForTests,
  runParityVerification,
} from "../../migration/verifier";
import { buildMcpToolsForChat } from "../../services/mcp-client.service";
import { completeMcpOAuthFlow } from "../../services/mcp-oauth.service";
import {
  DualMcpRepository,
  isDuplicateServerNameError,
  MCP_DOMAIN,
  MCP_OAUTH_FLOW_TTL_MS,
  MCP_SHADOW_OPTIONS,
  McpDuplicateServerNameError,
  MongoMcpRepository,
  PgMcpRepository,
  resetMcpRepoForTests,
  setMcpRepoForTests,
} from "./index";

describe("Phase 3 MCP repository & migration contract suite", () => {
  let mongoServer: MongoMemoryServer;
  let pg: PGlite;
  let db: MakoPgDb;
  let mongoRepo: MongoMcpRepository;
  let pgRepo: PgMcpRepository;

  const user1Uuid = generateUuidv7();
  const user2Uuid = generateUuidv7();
  const wsId = newDualId().oid;
  const wsUuid = objectIdToUuid(wsId);

  beforeAll(async () => {
    mongoServer = await MongoMemoryServer.create();
    await mongoose.connect(mongoServer.getUri(), { dbName: "mako_mcp_test" });
    await McpServer.createIndexes();
    await McpConnectionConfig.createIndexes();
    await McpOAuthFlow.createIndexes();
    await McpToolGrant.createIndexes();

    pg = createTestPglite();
    db = drizzle(pg, { schema }) as unknown as MakoPgDb;
    const migrationsFolder = resolveMigrationsFolder();
    await drizzlePgliteMigrate(drizzle(pg), { migrationsFolder });
    await drizzlePgliteMigrate(drizzle(pg), { migrationsFolder });
    setPgTestDb(db);

    await pg.query(
      `INSERT INTO users (id, legacy_id, email) VALUES
        ($1::uuid, $1::text, 'mcp-u1@example.com'),
        ($2::uuid, $2::text, 'mcp-u2@example.com')`,
      [user1Uuid, user2Uuid],
    );
    await pg.query(
      `INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, 'MCP WS', 'mcp-ws', $2)`,
      [wsUuid, user1Uuid],
    );

    mongoRepo = new MongoMcpRepository();
    pgRepo = new PgMcpRepository({ getDb: () => db });
  });

  afterAll(async () => {
    resetPgTestDb();
    await pg.close();
    await mongoose.disconnect();
    await mongoServer.stop();
  });

  beforeEach(async () => {
    await Promise.all([
      McpServer.deleteMany({}),
      McpConnectionConfig.deleteMany({}),
      McpOAuthFlow.deleteMany({}),
      McpToolGrant.deleteMany({}),
    ]);
    await pg.exec(`
      TRUNCATE mcp_tool_grants, mcp_oauth_flows, mcp_connection_configs, mcp_servers,
               migration_domain_state, migration_backfill_jobs, migration_tombstones, migration_quarantine
      CASCADE;
    `);
  });

  it("enforces schema constraints, UNIQUE NULLS NOT DISTINCT on shared configs, and ON DELETE CASCADE", async () => {
    const tables = await pg.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN ('mcp_servers', 'mcp_connection_configs', 'mcp_oauth_flows', 'mcp_tool_grants')
        ORDER BY table_name`,
    );
    expect(tables.rows.map(r => r.table_name)).toEqual([
      "mcp_connection_configs",
      "mcp_oauth_flows",
      "mcp_servers",
      "mcp_tool_grants",
    ]);

    const server = await pgRepo.createServer({
      workspaceId: wsId,
      name: "Close CRM",
      connectorType: "close",
      transport: { type: "http", url: "https://mcp.close.com/mcp" },
      authType: "api_key",
      authPerformer: "workspace",
      writeScope: "read",
      createdBy: user1Uuid,
    });

    // Duplicate server name in same workspace -> McpDuplicateServerNameError.
    await expect(
      pgRepo.createServer({
        workspaceId: wsId,
        name: "Close CRM",
        connectorType: "close",
        transport: { type: "http", url: "https://mcp.close.com/mcp" },
        authType: "api_key",
        authPerformer: "workspace",
        writeScope: "read",
        createdBy: user1Uuid,
      }),
    ).rejects.toBeInstanceOf(McpDuplicateServerNameError);

    // Upsert workspace-shared credential (userId: null) twice -> single row via UNIQUE NULLS NOT DISTINCT!
    const firstShared = await pgRepo.upsertConnectionCredentials({
      workspaceId: wsId,
      serverId: server.id,
      userId: null,
      headersEncrypted: { "Close-API-Key": "iv1:cipher1" },
    });
    const secondShared = await pgRepo.upsertConnectionCredentials({
      workspaceId: wsId,
      serverId: server.id,
      userId: null,
      headersEncrypted: { "Close-API-Key": "iv2:cipher2" },
    });
    expect(secondShared.id).toBe(firstShared.id);
    expect(secondShared.userId).toBeNull();
    expect(secondShared.headersEncrypted).toEqual({
      "Close-API-Key": "iv2:cipher2",
    });

    // Per-user config coexists alongside workspace-shared config.
    const userCfg = await pgRepo.upsertConnectionCredentials({
      workspaceId: wsId,
      serverId: server.id,
      userId: user1Uuid,
      headersEncrypted: { Authorization: "iv3:cipher3" },
    });
    expect(userCfg.userId).toBe(user1Uuid);

    const allConfigs = await pgRepo.listConnectionConfigsByServerIds(wsId, [
      server.id,
    ]);
    expect(allConfigs).toHaveLength(2);

    // Raw duplicate INSERT with user_id = NULL violates UNIQUE NULLS NOT DISTINCT.
    await expect(
      pg.query(
        `INSERT INTO mcp_connection_configs (id, workspace_id, server_id, user_id, headers_encrypted)
         VALUES ($1, $2, $3, NULL, '{}'::jsonb)`,
        [newDualId().uuid, wsUuid, objectIdToUuid(server.id)],
      ),
    ).rejects.toThrow();

    // Add flow + grant, then verify DELETE FROM mcp_servers cascades all 3 child tables.
    await pgRepo.upsertOAuthFlow({
      state: "state-cascade",
      workspaceId: wsId,
      serverId: server.id,
      configUserId: null,
      startedByUserId: user1Uuid,
      codeVerifierEncrypted: "iv4:pkce4",
    });
    await pgRepo.upsertToolGrant({
      workspaceId: wsId,
      serverId: server.id,
      userId: user1Uuid,
      toolName: "*",
      decision: "always_allow",
    });

    expect(await pgRepo.deleteServerCascade(wsId, server.id)).toBe(true);
    expect(
      await pgRepo.listConnectionConfigsByServerIds(wsId, [server.id]),
    ).toEqual([]);
    expect(await pgRepo.findOAuthFlowByState("state-cascade")).toBeNull();
    expect(
      await pgRepo.listToolGrantsForUser(wsId, server.id, user1Uuid),
    ).toEqual([]);
  });

  it("redacts all 4 encrypted MCP fields in shadow-compare diffs", () => {
    const left = {
      id: "s1",
      oauthClientInformationEncrypted: "iv1:secret_client_A",
      headersEncrypted: { Authorization: "iv2:secret_header_A" },
      oauthTokensEncrypted: "iv3:secret_token_A",
      codeVerifierEncrypted: "iv4:secret_pkce_A",
    };
    const right = {
      id: "s1",
      oauthClientInformationEncrypted: "iv1:secret_client_B",
      headersEncrypted: { Authorization: "iv2:secret_header_B" },
      oauthTokensEncrypted: "iv3:secret_token_B",
      codeVerifierEncrypted: "iv4:secret_pkce_B",
    };
    const diff = computeDiffPaths(left, right, MCP_SHADOW_OPTIONS);
    expect(diff.equal).toBe(false);
    expect(diff.diffs).toHaveLength(4);
    for (const d of diff.diffs) {
      expect(d.redacted).toBe(true);
    }
    const serialized = JSON.stringify(diff);
    expect(serialized).not.toContain("secret_client");
    expect(serialized).not.toContain("secret_header");
    expect(serialized).not.toContain("secret_token");
    expect(serialized).not.toContain("secret_pkce");
  });

  it("enforces 10m read-time SQL guard, hourly TTL reaper, and Stage 4 PG->Mongo fallback for mcp_oauth_flows", async () => {
    const router = new MigrationRouter({
      getDb: () => db,
      hasPg: () => true,
      enablePubSub: false,
      cacheTtlMs: 0,
    });
    const dualRepo = new DualMcpRepository({
      mongo: mongoRepo,
      pg: pgRepo,
      router,
      getDb: () => db,
      hasPg: () => true,
    });

    await router.setDomainState({
      domain: MCP_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_mongo_read",
    });

    const server = await dualRepo.createServer({
      workspaceId: wsId,
      name: "Slack",
      connectorType: "slack",
      transport: { type: "http", url: "https://mcp.slack.com/mcp" },
      authType: "oauth",
      authPerformer: "user",
      writeScope: "read",
      oauthClientInformationEncrypted: "iv0:dcr_client_cipher",
      createdBy: user1Uuid,
    });

    const now = new Date("2026-11-26T12:00:00Z");
    const expiredAt = new Date(now.getTime() - MCP_OAUTH_FLOW_TTL_MS - 1_000);
    const freshAt = new Date(now.getTime() - 60_000);

    // Insert expired & fresh flows directly in PG to test read-time SQL guard & reaper.
    await pgRepo.upsertOAuthFlow({
      state: "expired-flow",
      workspaceId: wsId,
      serverId: server.id,
      configUserId: user1Uuid,
      startedByUserId: user1Uuid,
      codeVerifierEncrypted: "ivE:expired_pkce",
      createdAt: expiredAt,
    });
    await pgRepo.upsertOAuthFlow({
      state: "fresh-flow",
      workspaceId: wsId,
      serverId: server.id,
      configUserId: user1Uuid,
      startedByUserId: user1Uuid,
      codeVerifierEncrypted: "ivF:fresh_pkce",
      createdAt: freshAt,
    });

    // Read-time SQL guard rejects >10m flow immediately (even before reaper runs).
    expect(await pgRepo.findOAuthFlowByState("expired-flow", now)).toBeNull();
    const fresh = await pgRepo.findOAuthFlowByState("fresh-flow", now);
    expect(fresh?.codeVerifierEncrypted).toBe("ivF:fresh_pkce");

    // Hourly TTL reaper deletes expired flow and preserves fresh flow.
    clearTtlRegistryForTests();
    registerMcpMigrationDomain();
    const rule = listTtlRules().find(r => r.tableName === "mcp_oauth_flows");
    if (!rule) throw new Error("expected mcp_oauth_flows TTL rule");
    expect(rule.olderThanMs).toBe(MCP_OAUTH_FLOW_TTL_MS);

    const reapRes = await reapExpiredRows(rule, { db, now });
    expect(reapRes.deleted).toBe(1);
    const remaining = await pg.query<{ state: string }>(
      `SELECT state FROM mcp_oauth_flows`,
    );
    expect(remaining.rows.map(r => r.state)).toEqual(["fresh-flow"]);

    // Stage 4 10m PG -> Mongo fallback: flow created ONLY in Mongo right before cutover
    // still resolves seamlessly after flipping to `dual_write_pg_read`!
    const mongoOnlyFlow = await mongoRepo.upsertOAuthFlow({
      state: "inflight-before-flip",
      workspaceId: wsId,
      serverId: server.id,
      configUserId: user1Uuid,
      startedByUserId: user1Uuid,
      codeVerifierEncrypted: "ivM:mongo_inflight_pkce",
      createdAt: freshAt,
    });
    expect(
      await pgRepo.findOAuthFlowByState("inflight-before-flip", now),
    ).toBeNull();

    await router.setDomainState({
      domain: MCP_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_pg_read",
    });
    await router.setDomainState({
      domain: MCP_DOMAIN,
      mode: "dual_write_pg_read",
    });

    const fallbackByState = await dualRepo.findOAuthFlowByState(
      "inflight-before-flip",
      now,
    );
    expect(fallbackByState?.id).toBe(mongoOnlyFlow.id);
    expect(fallbackByState?.codeVerifierEncrypted).toBe(
      "ivM:mongo_inflight_pkce",
    );

    const fallbackById = await dualRepo.findOAuthFlowById(
      mongoOnlyFlow.id,
      wsId,
      now,
    );
    expect(fallbackById?.state).toBe("inflight-before-flip");
  });

  it("passes full 5-stage lifecycle + Stage 4->2 rollback with 0 shadow mismatches", async () => {
    const shadowEvents: ShadowCompareEvent[] = [];
    const shadowRunner = new ShadowCompareRunner({
      onEvent: e => shadowEvents.push(e),
    });
    const router = new MigrationRouter({
      getDb: () => db,
      hasPg: () => true,
      enablePubSub: false,
      cacheTtlMs: 0,
      shadowRunner,
      rng: () => 0,
    });
    const dualRepo = new DualMcpRepository({
      mongo: mongoRepo,
      pg: pgRepo,
      router,
      getDb: () => db,
      hasPg: () => true,
    });

    // Stage 1: mongo_only
    const s1 = await dualRepo.createServer({
      workspaceId: wsId,
      name: "Stage1 Server",
      connectorType: "custom",
      transport: { type: "http", url: "https://s1.example.com/mcp" },
      authType: "api_key",
      authPerformer: "workspace",
      writeScope: "write_safe",
      status: "connected",
      createdBy: user1Uuid,
    });
    expect(await pgRepo.findServerById(s1.id, wsId)).toBeNull();

    // Stage 2: dual_write_mongo_read
    await router.setDomainState({
      domain: MCP_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_mongo_read",
    });
    const s2 = await dualRepo.createServer({
      workspaceId: wsId,
      name: "GitHub MCP",
      connectorType: "github",
      transport: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
      authType: "oauth",
      authPerformer: "user",
      writeScope: "write_destructive",
      oauthClientInformationEncrypted: "iv_gh:opaque_client_info",
      status: "connected",
      createdBy: user1Uuid,
    });
    expect((await pgRepo.findServerById(s2.id, wsId))?.name).toBe("GitHub MCP");

    await dualRepo.upsertConnectionOAuthTokens({
      workspaceId: wsId,
      serverId: s2.id,
      userId: user1Uuid,
      oauthTokensEncrypted: "iv_tok:opaque_tokens",
      oauthExpiresAt: Date.UTC(2027, 0, 1),
    });
    await dualRepo.upsertToolGrant({
      workspaceId: wsId,
      serverId: s2.id,
      userId: user1Uuid,
      toolName: "create_issue",
      decision: "always_allow",
    });

    // Duplicate name rejected identically in Stage 2.
    await expect(
      dualRepo.createServer({
        workspaceId: wsId,
        name: "GitHub MCP",
        connectorType: "github",
        transport: { type: "http", url: "https://api.githubcopilot.com/mcp/" },
        authType: "oauth",
        authPerformer: "user",
        writeScope: "read",
        createdBy: user1Uuid,
      }),
    ).rejects.toSatisfy(isDuplicateServerNameError);

    // Stage 3: dual_write_shadow_compare -> 0 mismatches
    await router.setDomainState({
      domain: MCP_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 1.0,
    });
    const listedS3 = await dualRepo.findServerById(s2.id, wsId);
    const cfgS3 = await dualRepo.findConnectionConfig(wsId, s2.id, user1Uuid);
    const grantsS3 = await dualRepo.listToolGrantsForUser(
      wsId,
      s2.id,
      user1Uuid,
    );
    await shadowRunner.flush();

    expect(listedS3?.oauthClientInformationEncrypted).toBe(
      "iv_gh:opaque_client_info",
    );
    expect(cfgS3?.oauthTokensEncrypted).toBe("iv_tok:opaque_tokens");
    expect(grantsS3).toHaveLength(1);
    expect(shadowEvents.length).toBeGreaterThanOrEqual(3);
    expect(shadowEvents.every(e => e.result === "match")).toBe(true);

    // Stage 4: dual_write_pg_read -> write in PG + reverse-sync to Mongo
    await router.setDomainState({
      domain: MCP_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_pg_read",
      shadowSampleRate: 1.0,
    });
    await dualRepo.updateServer(wsId, s2.id, {
      description: "Updated during Stage 4",
      toolPolicy: {
        defaultRestriction: "ask",
        restrictions: { delete_repo: "block" },
      },
    });
    await dualRepo.upsertToolGrant({
      workspaceId: wsId,
      serverId: s2.id,
      userId: user2Uuid,
      toolName: "*",
      decision: "always_deny",
    });

    // Instant rollback Stage 4 -> Stage 2: Mongo MUST have the Stage 4 writes!
    await router.setDomainState({
      domain: MCP_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_mongo_read",
    });
    const afterRollback = await dualRepo.findServerById(s2.id, wsId);
    expect(afterRollback?.description).toBe("Updated during Stage 4");
    expect(afterRollback?.toolPolicy).toEqual({
      defaultRestriction: "ask",
      restrictions: { delete_repo: "block" },
    });
    const user2GrantsAfterRollback = await dualRepo.listToolGrantsForUser(
      wsId,
      s2.id,
      user2Uuid,
    );
    expect(user2GrantsAfterRollback).toHaveLength(1);
    expect(user2GrantsAfterRollback[0].decision).toBe("always_deny");

    // Stage 5: pg_only -> writes PG only, Mongo untouched
    await router.setDomainState({
      domain: MCP_DOMAIN,
      workspaceId: wsId,
      mode: "pg_only",
    });
    const s5 = await dualRepo.createServer({
      workspaceId: wsId,
      name: "PG Only Server",
      connectorType: "custom",
      transport: { type: "http", url: "https://pgonly.example.com/mcp" },
      authType: "none",
      authPerformer: "workspace",
      writeScope: "read",
      createdBy: user1Uuid,
    });
    expect((await pgRepo.findServerById(s5.id, wsId))?.name).toBe(
      "PG Only Server",
    );
    expect(await mongoRepo.findServerById(s5.id, wsId)).toBeNull();
  });

  it("backfills mcp tables in FK order (skipping oauth_flows), quarantines orphans, honors tombstones, and verifies/repairs parity", async () => {
    clearBackfillRegistryForTests();
    clearVerifierRegistryForTests();
    registerMcpMigrationDomain();

    // Seed valid server + shared config + user config + grant + ephemeral flow in Mongo.
    const server = await mongoRepo.createServer({
      workspaceId: wsId,
      name: "Linear MCP",
      connectorType: "custom",
      transport: { type: "http", url: "https://mcp.linear.app/mcp" },
      authType: "oauth",
      authPerformer: "user",
      writeScope: "write_safe",
      oauthClientInformationEncrypted: "iv_lin:dcr_cipher",
      status: "connected",
      createdBy: user1Uuid,
    });
    await mongoRepo.upsertConnectionCredentials({
      workspaceId: wsId,
      serverId: server.id,
      userId: null,
      headersEncrypted: { "X-Team": "iv_h:cipher_team" },
    });
    await mongoRepo.upsertConnectionOAuthTokens({
      workspaceId: wsId,
      serverId: server.id,
      userId: user1Uuid,
      oauthTokensEncrypted: "iv_t:cipher_tok",
      oauthExpiresAt: Date.UTC(2027, 5, 1),
    });
    const grant = await mongoRepo.upsertToolGrant({
      workspaceId: wsId,
      serverId: server.id,
      userId: user1Uuid,
      toolName: "issue_create",
      decision: "always_allow",
    });
    // Ephemeral OAuth flow MUST be skipped by backfill.
    await mongoRepo.upsertOAuthFlow({
      state: "ephemeral-skip",
      workspaceId: wsId,
      serverId: server.id,
      configUserId: user1Uuid,
      startedByUserId: user1Uuid,
      codeVerifierEncrypted: "iv_v:pkce",
    });

    // Seed an orphan config whose serverId does not exist -> must be quarantined!
    await McpConnectionConfig.create({
      workspaceId: new Types.ObjectId(wsId),
      serverId: new Types.ObjectId(),
      userId: "",
      headers: { "X-Orphan": "iv:orphan" },
    });

    // Seed a server deleted during Stage 2 with a tombstone -> must NOT resurrect!
    const deletedServer = await mongoRepo.createServer({
      workspaceId: wsId,
      name: "Tombstoned Server",
      connectorType: "custom",
      transport: { type: "http", url: "https://dead.example.com/mcp" },
      authType: "none",
      authPerformer: "workspace",
      writeScope: "read",
      createdBy: user1Uuid,
    });
    await pg.query(
      `INSERT INTO migration_tombstones (table_name, entity_id, deleted_at)
       VALUES ('mcp_servers', $1, now())`,
      [objectIdToUuid(deletedServer.id)],
    );

    const summary = await runBackfill({
      domain: MCP_DOMAIN,
      workspaceId: wsId,
      batchSize: 2,
      db,
    });
    expect(summary.status).toBe("completed");
    expect(summary.rowsQuarantined).toBe(1);
    expect(summary.rowsSkippedTombstone).toBe(1);
    expect(summary.rowsUpserted).toBe(4); // 1 server + 2 configs + 1 grant

    // Confirm oauth_flows table remained empty (skipped backfill).
    const flowCount = await pg.query<{ c: string }>(
      `SELECT count(*)::text AS c FROM mcp_oauth_flows`,
    );
    expect(Number(flowCount.rows[0].c)).toBe(0);

    // Confirm tombstoned server was not resurrected.
    expect(await pgRepo.findServerById(deletedServer.id, wsId)).toBeNull();

    // Remove the orphan Mongo doc so verifier checks clean live parity.
    await McpConnectionConfig.deleteMany({
      serverId: { $ne: new Types.ObjectId(server.id) },
    });

    const reportClean = await runParityVerification({
      domain: MCP_DOMAIN,
      workspaceId: wsId,
      db,
    });
    expect(reportClean.ok).toBe(true);
    expect(reportClean.checked).toBe(4);
    expect(reportClean.matched).toBe(4);
    expect(reportClean.skippedTombstone).toBe(1);

    // Introduce drift in PG and verify `--repair` heals it back to 100% parity.
    await pg.query(
      `UPDATE mcp_tool_grants SET decision = 'always_deny', updated_at = '2020-01-01T00:00:00Z'
        WHERE id = $1`,
      [objectIdToUuid(grant.id)],
    );
    const reportDrift = await runParityVerification({
      domain: MCP_DOMAIN,
      workspaceId: wsId,
      repair: true,
      db,
    });
    expect(reportDrift.ok).toBe(false);
    expect(reportDrift.mismatched).toBe(1);
    expect(reportDrift.repaired).toBe(1);

    const reportAfterRepair = await runParityVerification({
      domain: MCP_DOMAIN,
      workspaceId: wsId,
      db,
    });
    expect(reportAfterRepair.ok).toBe(true);
  });

  it("handles Verifier #60 regressions: wrong-user no-op tombstones, distinct 15-char legacy_id Stage 3 shadow-compare, shared clearServerOAuthTokens updatedAt, natural-key sync-retry + reverse-mapping, and UUIDv8 Mongo symmetry", async () => {
    const legacyUserId = "u_legacy_mcp001";
    const legacyUserUuid = generateUuidv7();
    await pg.query(
      `INSERT INTO users (id, legacy_id, email) VALUES ($1::uuid, $2::text, 'mcp-legacy@example.com')`,
      [legacyUserUuid, legacyUserId],
    );

    const shadowEvents: ShadowCompareEvent[] = [];
    const shadowRunner = new ShadowCompareRunner({
      onEvent: e => shadowEvents.push(e),
    });
    const router = new MigrationRouter({
      getDb: () => db,
      hasPg: () => true,
      enablePubSub: false,
      cacheTtlMs: 0,
      shadowRunner,
      rng: () => 0,
    });
    const dualRepo = new DualMcpRepository({
      mongo: mongoRepo,
      pg: pgRepo,
      router,
      getDb: () => db,
      hasPg: () => true,
    });

    // Stage 2: create server, config, grant under distinct 15-char legacy_id
    await router.setDomainState({
      domain: MCP_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_mongo_read",
    });
    const server = await dualRepo.createServer({
      workspaceId: wsId,
      name: "Legacy User CRM",
      connectorType: "close",
      transport: { type: "http", url: "https://mcp.legacy.example.com" },
      authType: "oauth",
      authPerformer: "user",
      writeScope: "read",
      createdBy: legacyUserId,
    });
    await dualRepo.upsertConnectionOAuthTokens({
      workspaceId: wsId,
      serverId: server.id,
      userId: legacyUserId,
      oauthTokensEncrypted: "iv_tok:legacy_secret",
      oauthExpiresAt: Date.UTC(2027, 1, 1),
    });
    const grant = await dualRepo.upsertToolGrant({
      workspaceId: wsId,
      serverId: server.id,
      userId: legacyUserId,
      toolName: "lead_update",
      decision: "always_allow",
    });

    // Defect #7: Mongo & PG accept UUIDv8 wire IDs symmetrically!
    const serverUuid = objectIdToUuid(server.id);
    expect((await mongoRepo.findServerById(serverUuid, wsUuid))?.id).toBe(
      server.id,
    );
    expect((await pgRepo.findServerById(serverUuid, wsUuid))?.id).toBe(
      server.id,
    );

    // Defect #2: Unauthorized wrong-user deleteToolGrantById & nonexistent deleteServerCascade
    // MUST return false and write ZERO tombstones in Stage 2!
    expect(
      await dualRepo.deleteToolGrantById(wsId, server.id, grant.id, user2Uuid),
    ).toBe(false);
    expect(await dualRepo.deleteServerCascade(wsId, newDualId().oid)).toBe(
      false,
    );
    const tombstones = await pg.query<{ table_name: string }>(
      `SELECT table_name FROM migration_tombstones`,
    );
    expect(tombstones.rows).toHaveLength(0);

    // Defect #4c: clearServerOAuthTokens keeps identical updatedAt across Mongo & PG
    const clearAt = new Date("2026-11-26T15:30:00.000Z");
    await dualRepo.clearServerOAuthTokens(wsId, server.id, clearAt);
    const mongoCfgAfterClear = await mongoRepo.findConnectionConfig(
      wsId,
      server.id,
      legacyUserId,
    );
    const pgCfgAfterClear = await pgRepo.findConnectionConfig(
      wsId,
      server.id,
      legacyUserId,
    );
    expect(mongoCfgAfterClear?.updatedAt.getTime()).toBe(clearAt.getTime());
    expect(pgCfgAfterClear?.updatedAt.getTime()).toBe(clearAt.getTime());

    // Defect #4a: Stage 3 shadow-compare with distinct 15-char legacy_id -> 0 mismatches across ALL reads!
    await router.setDomainState({
      domain: MCP_DOMAIN,
      workspaceId: wsId,
      mode: "dual_write_shadow_compare",
      shadowSampleRate: 1.0,
    });
    await dualRepo.listServersByWorkspace(wsId);
    await dualRepo.findServerById(server.id, wsId);
    await dualRepo.listConnectionConfigsByServerIds(wsId, [server.id]);
    await dualRepo.findConnectionConfig(wsId, server.id, legacyUserId);
    await dualRepo.listToolGrantsForUser(wsId, server.id, legacyUserId);
    await dualRepo.findToolGrantsForResolution({
      workspaceId: wsId,
      serverId: server.id,
      userId: legacyUserId,
      toolName: "lead_update",
    });
    await shadowRunner.flush();
    expect(shadowEvents.length).toBe(6);
    expect(shadowEvents.every(e => e.result === "match")).toBe(true);

    // Defect #3: Sync-retry natural-key lookup for updated mcp_tool_grants (PG & Mongo)
    // AND legacy_id reverse-mapping in replayMcpWriteToMongo (no duplicate configs!).
    clearSyncRetryHandlersForTests();
    registerMcpMigrationDomain();
    const pgRetry = getSyncRetryHandler("pg", MCP_DOMAIN);
    const mongoRetry = getSyncRetryHandler("mongo", MCP_DOMAIN);
    if (!pgRetry || !mongoRetry) {
      throw new Error("expected MCP sync-retry handlers");
    }

    // Update existing grant ONLY in Mongo (with fresh minted entityId different from grant.id),
    // then replay to PG using natural key (serverId, userId, toolName).
    const tUpdate1 = new Date(Date.now() + 60_000);
    await mongoRepo.upsertToolGrant({
      workspaceId: wsId,
      serverId: server.id,
      userId: legacyUserId,
      toolName: "lead_update",
      decision: "always_deny",
      now: tUpdate1,
    });
    await pgRetry({
      target: "pg",
      domain: MCP_DOMAIN,
      operation: "upsertToolGrant",
      entityId: newDualId().oid, // Fresh minted ID != existing grant.id!
      workspaceId: wsId,
      payload: {
        entity: "mcp_tool_grants",
        workspaceId: wsId,
        serverId: server.id,
        userId: legacyUserId,
        toolName: "lead_update",
      },
      failedAt: tUpdate1.toISOString(),
      errorMessage: "simulated_pg_timeout",
    });
    const pgGrantAfterRetry = await pgRepo.listToolGrantsForUser(
      wsId,
      server.id,
      legacyUserId,
    );
    expect(pgGrantAfterRetry[0]?.decision).toBe("always_deny");

    // Stage 4 PG-only update on config & grant using PG UUIDv7 -> replayMcpWriteToMongo
    // MUST reverse-map UUIDv7 -> legacy_id (0 duplicate configs, updates existing legacy grant).
    const tUpdate2 = new Date(Date.now() + 120_000);
    await pgRepo.upsertConnectionCredentials({
      workspaceId: wsId,
      serverId: server.id,
      userId: legacyUserUuid,
      headersEncrypted: { Authorization: "iv_stage4:replayed" },
      now: tUpdate2,
    });
    await pgRepo.upsertToolGrant({
      workspaceId: wsId,
      serverId: server.id,
      userId: legacyUserUuid,
      toolName: "lead_update",
      decision: "always_allow",
      now: tUpdate2,
    });
    await mongoRetry({
      target: "mongo",
      domain: MCP_DOMAIN,
      operation: "upsertConnectionCredentials",
      entityId: server.id,
      workspaceId: wsId,
      payload: {
        entity: "mcp_connection_configs",
        workspaceId: wsId,
        serverId: server.id,
        userId: legacyUserUuid,
      },
      failedAt: tUpdate2.toISOString(),
      errorMessage: "simulated_mongo_timeout",
    });
    await mongoRetry({
      target: "mongo",
      domain: MCP_DOMAIN,
      operation: "upsertToolGrant",
      entityId: newDualId().oid, // Fresh minted ID != existing grant.id!
      workspaceId: wsId,
      payload: {
        entity: "mcp_tool_grants",
        workspaceId: wsId,
        serverId: server.id,
        userId: legacyUserUuid,
        toolName: "lead_update",
      },
      failedAt: tUpdate2.toISOString(),
      errorMessage: "simulated_mongo_timeout",
    });

    const allMongoConfigs = await McpConnectionConfig.find({
      serverId: new Types.ObjectId(server.id),
    }).lean();
    expect(allMongoConfigs).toHaveLength(1);
    expect(allMongoConfigs[0]?.userId).toBe(legacyUserId);
    expect(
      (allMongoConfigs[0]?.headers as Record<string, string>)?.Authorization,
    ).toBe("iv_stage4:replayed");

    const mongoGrantsAfterRetry = await mongoRepo.listToolGrantsForUser(
      wsId,
      server.id,
      legacyUserId,
    );
    expect(mongoGrantsAfterRetry).toHaveLength(1);
    expect(mongoGrantsAfterRetry[0]?.decision).toBe("always_allow");

    // Stage 4 delete replay with PG UUIDv7 deletes the legacy-owned Mongo grant!
    await pgRepo.deleteToolGrantById(wsId, server.id, grant.id, legacyUserUuid);
    await mongoRetry({
      target: "mongo",
      domain: MCP_DOMAIN,
      operation: "deleteToolGrantById",
      entityId: grant.id,
      workspaceId: wsId,
      payload: {
        entity: "mcp_tool_grants",
        action: "delete",
        workspaceId: wsId,
        serverId: server.id,
        grantId: grant.id,
        userId: legacyUserUuid,
      },
      failedAt: new Date().toISOString(),
      errorMessage: "simulated_mongo_timeout",
    });
    expect(
      await mongoRepo.listToolGrantsForUser(wsId, server.id, legacyUserId),
    ).toEqual([]);
  });

  it("matches legacy session user IDs against PG UUIDv7 in OAuth callbacks and per-user MCP configs (PR #1558 [4717349100], [4717349735])", async () => {
    const legacyOwnerId = "lucia_mcp_own01";
    const legacyOwnerUuid = generateUuidv7();
    const legacyOtherId = "lucia_mcp_oth02";
    const legacyOtherUuid = generateUuidv7();

    await pg.query(
      `INSERT INTO users (id, legacy_id, email) VALUES
        ($1::uuid, $2, 'mcp-mixed-owner@example.com'),
        ($3::uuid, $4, 'mcp-mixed-other@example.com')`,
      [legacyOwnerUuid, legacyOwnerId, legacyOtherUuid, legacyOtherId],
    );

    const router = new MigrationRouter({
      getDb: () => db,
      hasPg: () => true,
      enablePubSub: false,
    });
    const dualRepo = new DualMcpRepository({
      mongo: mongoRepo,
      pg: pgRepo,
      router,
      getDb: () => db,
      hasPg: () => true,
      isForceMongoOnly: () => false,
    });

    await router.setDomainState({
      domain: MCP_DOMAIN,
      workspaceId: wsId,
      mode: "pg_only",
    });

    // ── [4717349100] OAuth callback user check in PG-read mode with legacy sessionUserId ──
    const oauthServer = await dualRepo.createServer({
      workspaceId: wsId,
      name: "Mixed Mode OAuth Server",
      connectorType: "slack",
      transport: { type: "http", url: "https://mcp.slack.com/mcp" },
      authType: "oauth",
      authPerformer: "user",
      writeScope: "read",
      status: "awaiting_auth",
      createdBy: legacyOwnerId,
    });

    const flow = await dualRepo.upsertOAuthFlow({
      state: "mixed-mode-oauth-state",
      workspaceId: wsId,
      serverId: oauthServer.id,
      configUserId: legacyOwnerId,
      startedByUserId: legacyOwnerId,
      codeVerifierEncrypted: "iv_pkce:cipher_mixed",
    });
    // PG returns UUIDv7 while auth (still on Mongo) supplies the 15-char Lucia ID.
    expect(flow.startedByUserId).toBe(legacyOwnerUuid);
    expect(await dualRepo.isSameUser(flow.startedByUserId, legacyOwnerId)).toBe(
      true,
    );
    expect(
      await dualRepo.isSameUser(flow.startedByUserId, legacyOwnerUuid),
    ).toBe(true);
    expect(await dualRepo.isSameUser(flow.startedByUserId, legacyOtherId)).toBe(
      false,
    );

    // Exercise real `completeMcpOAuthFlow`: remove server so owner check passes and hits
    // "MCP server no longer exists" (line 349), while a different user fails with
    // "This OAuth flow was started by a different user" (line 345).
    const orphanServer = await dualRepo.createServer({
      workspaceId: wsId,
      name: "Temp OAuth Server",
      connectorType: "slack",
      transport: { type: "http", url: "https://mcp.slack.com/mcp" },
      authType: "oauth",
      authPerformer: "user",
      writeScope: "read",
      status: "awaiting_auth",
      createdBy: legacyOwnerId,
    });
    await dualRepo.upsertOAuthFlow({
      state: "mixed-mode-callback-check",
      workspaceId: wsId,
      serverId: orphanServer.id,
      configUserId: legacyOwnerId,
      startedByUserId: legacyOwnerId,
      codeVerifierEncrypted: "iv_pkce:cipher_cb",
    });
    // Mock findServerById returning null after flow lookup so we test exact owner-check branch
    // without touching the network.
    const origFindServerById = dualRepo.findServerById.bind(dualRepo);
    setMcpRepoForTests({
      ...dualRepo,
      listServersByWorkspace: id => dualRepo.listServersByWorkspace(id),
      listActiveConnectedServers: id => dualRepo.listActiveConnectedServers(id),
      findServerById: (sid, wsid) =>
        sid === orphanServer.id
          ? Promise.resolve(null)
          : origFindServerById(sid, wsid),
      createServer: inp => dualRepo.createServer(inp),
      updateServer: (w, s, p) => dualRepo.updateServer(w, s, p),
      deleteServerCascade: (w, s) => dualRepo.deleteServerCascade(w, s),
      listConnectionConfigsByServerIds: (w, ids) =>
        dualRepo.listConnectionConfigsByServerIds(w, ids),
      listConnectionConfigsForUser: (w, ids, u) =>
        dualRepo.listConnectionConfigsForUser(w, ids, u),
      findConnectionConfig: (w, s, u) => dualRepo.findConnectionConfig(w, s, u),
      upsertConnectionCredentials: inp =>
        dualRepo.upsertConnectionCredentials(inp),
      upsertConnectionOAuthTokens: inp =>
        dualRepo.upsertConnectionOAuthTokens(inp),
      clearServerOAuthTokens: (w, s, n) =>
        dualRepo.clearServerOAuthTokens(w, s, n),
      upsertOAuthFlow: inp => dualRepo.upsertOAuthFlow(inp),
      findOAuthFlowByState: (st, n) => dualRepo.findOAuthFlowByState(st, n),
      findOAuthFlowById: (fid, w, n) => dualRepo.findOAuthFlowById(fid, w, n),
      deleteOAuthFlowById: (fid, w) => dualRepo.deleteOAuthFlowById(fid, w),
      isSameUser: (a, b) => dualRepo.isSameUser(a, b),
      listToolGrantsForUser: (w, s, u) =>
        dualRepo.listToolGrantsForUser(w, s, u),
      findToolGrantsForResolution: p => dualRepo.findToolGrantsForResolution(p),
      upsertToolGrant: inp => dualRepo.upsertToolGrant(inp),
      touchToolGrantLastUsed: p => dualRepo.touchToolGrantLastUsed(p),
      deleteToolGrantById: (w, s, g, u) =>
        dualRepo.deleteToolGrantById(w, s, g, u),
    });

    try {
      await expect(
        completeMcpOAuthFlow({
          state: "mixed-mode-callback-check",
          code: "dummy-code",
          sessionUserId: legacyOwnerId,
        }),
      ).rejects.toThrow("MCP server no longer exists");

      await expect(
        completeMcpOAuthFlow({
          state: "mixed-mode-callback-check",
          code: "dummy-code",
          sessionUserId: legacyOtherId,
        }),
      ).rejects.toThrow("This OAuth flow was started by a different user");

      // ── [4717349735] Per-user MCP tools & connection status with legacy session userId ──
      const perUserServer = await dualRepo.createServer({
        workspaceId: wsId,
        name: "Personal CRM",
        connectorType: "close",
        transport: { type: "http", url: "https://mcp.close.com/mcp" },
        authType: "api_key",
        authPerformer: "user",
        writeScope: "read",
        status: "connected",
        createdBy: legacyOwnerId,
        cachedTools: [
          {
            name: "lead_search",
            description: "Search leads",
            annotations: { readOnlyHint: true },
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });
      const sharedServer = await dualRepo.createServer({
        workspaceId: wsId,
        name: "Shared Docs",
        connectorType: "custom",
        transport: { type: "http", url: "https://mcp.example.com/mcp" },
        authType: "api_key",
        authPerformer: "workspace",
        writeScope: "read",
        status: "connected",
        createdBy: legacyOwnerId,
        cachedTools: [
          {
            name: "doc_search",
            description: "Search docs",
            annotations: { readOnlyHint: true },
            inputSchema: { type: "object", properties: {} },
          },
        ],
      });

      await dualRepo.upsertConnectionCredentials({
        workspaceId: wsId,
        serverId: perUserServer.id,
        userId: legacyOwnerId,
        headersEncrypted: { Authorization: "iv_owner:cipher_owner" },
      });
      await dualRepo.upsertConnectionCredentials({
        workspaceId: wsId,
        serverId: sharedServer.id,
        userId: null,
        headersEncrypted: { Authorization: "iv_ws:cipher_ws" },
      });

      // listConnectionConfigsForUser returns workspace-shared + owner's config (NOT other user's).
      const ownerConfigs = await dualRepo.listConnectionConfigsForUser(
        wsId,
        [perUserServer.id, sharedServer.id],
        legacyOwnerId,
      );
      expect(
        ownerConfigs.some(
          c => c.serverId === perUserServer.id && c.userId !== null,
        ),
      ).toBe(true);
      expect(
        ownerConfigs.some(
          c => c.serverId === sharedServer.id && c.userId === null,
        ),
      ).toBe(true);

      const otherConfigs = await dualRepo.listConnectionConfigsForUser(
        wsId,
        [perUserServer.id, sharedServer.id],
        legacyOtherId,
      );
      expect(
        otherConfigs.some(
          c => c.serverId === perUserServer.id && c.userId !== null,
        ),
      ).toBe(false);
      expect(
        otherConfigs.some(
          c => c.serverId === sharedServer.id && c.userId === null,
        ),
      ).toBe(true);

      // buildMcpToolsForChat exposes personal CRM tools for legacyOwnerId, not legacyOtherId.
      const ownerTools = await buildMcpToolsForChat({
        workspaceId: wsId,
        userId: legacyOwnerId,
      });
      expect(ownerTools.allToolNames).toContain("mcp_personal_crm_lead_search");
      expect(ownerTools.allToolNames).toContain("mcp_shared_docs_doc_search");

      const otherTools = await buildMcpToolsForChat({
        workspaceId: wsId,
        userId: legacyOtherId,
      });
      expect(otherTools.allToolNames).not.toContain(
        "mcp_personal_crm_lead_search",
      );
      expect(otherTools.allToolNames).toContain("mcp_shared_docs_doc_search");
    } finally {
      resetMcpRepoForTests();
    }
  });
});

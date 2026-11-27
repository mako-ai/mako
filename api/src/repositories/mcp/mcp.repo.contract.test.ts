import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as drizzlePgliteMigrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
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
import { McpDuplicateServerNameError, PgMcpRepository } from "./index";

describe("Phase 3 MCP repository & migration contract suite", () => {
  let pg: PGlite;
  let db: MakoPgDb;
  let pgRepo: PgMcpRepository;

  const user1Uuid = generateUuidv7();
  const user2Uuid = generateUuidv7();
  const wsId = newDualId().oid;
  const wsUuid = objectIdToUuid(wsId);

  beforeAll(async () => {
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
    pgRepo = new PgMcpRepository({ getDb: () => db });
  });

  afterAll(async () => {
    resetPgTestDb();
    await pg.close();
  });

  beforeEach(async () => {
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
});

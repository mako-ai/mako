import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as drizzlePgliteMigrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MakoPgDb } from "./client";
import {
  generateUuidv7,
  isUuidv7,
  objectIdToUuid,
  uuidv7Timestamp,
} from "./id-codec";
import { resolveMigrationsFolder } from "./migrate";
import {
  POST_BACKFILL_STEPS,
  readPostBackfillStatements,
  runPostBackfillStep,
} from "./post-backfill";
import * as schema from "./schema";
import { createTestPglite } from "./test-pglite";

const EXPECTED_TABLES = [
  // Phase 0: control plane (4)
  "migration_backfill_jobs",
  "migration_domain_state",
  "migration_quarantine",
  "migration_tombstones",
  // Phase 1A: auth (6)
  "desktop_auth_codes",
  "email_verifications",
  "oauth_accounts",
  "sessions",
  "user_attributions",
  "users",
  // Phase 1B: workspaces_core + github_installations (10)
  "acp_plan_grants",
  "github_installations",
  "mcp_oauth_clients",
  "mcp_oauth_codes",
  "mcp_oauth_tokens",
  "workspace_api_keys",
  "workspace_invites",
  "workspace_members",
  "workspace_user_handles",
  "workspaces",
  // Phase 2A-1: connections (5)
  "connection_access_events",
  "connection_write_events",
  "connector_definitions",
  "database_connections",
  "source_connections",
  // Phase 2A-2: consoles_charts (7)
  "console_folders",
  "entity_versions",
  "favourites",
  "notebook_folders",
  "notebook_indexes",
  "saved_consoles",
  "scheduled_query_runs",
  // Phase 2B: apps_metadata (10)
  "app_binding_drafts",
  "app_binding_jobs",
  "app_binding_state",
  "app_deploy_commit_statuses",
  "app_embeddings",
  "app_index",
  "app_index_heads",
  "app_lifecycle",
  "app_projects",
  "app_worktrees",
  // Phase 2B: usage_stats (7)
  "app_feed_snapshots",
  "app_usage_daily",
  "app_usage_events",
  "connection_verifications",
  "llm_usage",
  "query_executions",
  "skill_usage_daily",
  // Phase 3: mcp (4)
  "mcp_connection_configs",
  "mcp_oauth_flows",
  "mcp_servers",
  "mcp_tool_grants",
  // Phase 3: normalized chat (6)
  "chat_attachments",
  "chat_message_part_metadata",
  "chat_message_parts",
  "chat_messages",
  "chat_usage_entries",
  "chats",
].sort();

const EXPECTED_POST_BACKFILL = [
  {
    step: "sessions-active-workspace-fk",
    constraint: "sessions_active_workspace_id_fk",
  },
  {
    step: "consoles-connection-fk",
    constraint: "saved_consoles_connection_id_fk",
  },
  {
    step: "conn-verif-connection-fk",
    constraint: "connection_verifications_connection_id_fk",
  },
  {
    step: "llm-usage-chat-fk",
    constraint: "fk_llm_usage_chat",
  },
] as const;

/**
 * Full-schema integration test across ALL 9 Drizzle migrations (`0000`–`0008`)
 * and ALL 4 deferred post-backfill FK steps (`0003a`, `0005a`, `0006a`, `0008a`)
 * on a single fresh PGlite instance.
 */
describe("Full Postgres migration schema (0000–0008 + 4 post-backfill FKs)", () => {
  let pg: PGlite;
  let db: MakoPgDb;

  beforeAll(async () => {
    pg = createTestPglite();
    db = drizzle(pg, { schema }) as unknown as MakoPgDb;
    const migrationsFolder = resolveMigrationsFolder();
    await drizzlePgliteMigrate(drizzle(pg), { migrationsFolder });
    // Verify Drizzle migration journal is idempotent on re-run.
    await drizzlePgliteMigrate(drizzle(pg), { migrationsFolder });
  });

  afterAll(async () => {
    await pg.close();
  });

  it("creates all 59 tables with zero stream-event tables and no chat_messages.parts jsonb column", async () => {
    const res = await pg.query<{ table_name: string }>(
      `SELECT table_name
         FROM information_schema.tables
        WHERE table_schema = 'public'
        ORDER BY table_name`,
    );
    const actual = res.rows.map(r => r.table_name).sort();
    expect(actual).toEqual(EXPECTED_TABLES);
    expect(actual).toHaveLength(59);
    expect(actual).not.toContain("stream_events");
    expect(actual).not.toContain("chat_stream_events");

    const chatMsgCols = await pg.query<{ column_name: string }>(
      `SELECT column_name
         FROM information_schema.columns
        WHERE table_schema = 'public' AND table_name = 'chat_messages'`,
    );
    expect(chatMsgCols.rows.map(r => r.column_name)).not.toContain("parts");

    // Verify 0000 SQL ObjectId <-> UUIDv8 codec round-trip.
    const sampleOid = "6745f6f4a1b2c3d4e5f60718";
    const codec = await pg.query<{ uuid_val: string; oid_val: string }>(
      `SELECT objectid_to_uuid($1)::text AS uuid_val,
              uuid_to_objectid(objectid_to_uuid($1)) AS oid_val`,
      [sampleOid],
    );
    expect(codec.rows[0]).toEqual({
      uuid_val: objectIdToUuid(sampleOid),
      oid_val: sampleOid,
    });
  });

  it("executes all 4 deferred post-backfill FK steps idempotently and enforces ON DELETE SET NULL", async () => {
    expect(POST_BACKFILL_STEPS.map(s => s.name)).toEqual(
      EXPECTED_POST_BACKFILL.map(e => e.step),
    );
    for (const { step } of EXPECTED_POST_BACKFILL) {
      expect(readPostBackfillStatements(step)).toHaveLength(3);
    }

    const userId = generateUuidv7();
    const wsId = objectIdToUuid("6745f6f4a1b2c3d4e5f61001");
    const danglingWsId = objectIdToUuid("6745f6f4a1b2c3d4e5f61099");
    const connId = objectIdToUuid("6745f6f4a1b2c3d4e5f61002");
    const danglingConnId = objectIdToUuid("6745f6f4a1b2c3d4e5f61098");
    const consoleValidId = objectIdToUuid("6745f6f4a1b2c3d4e5f61003");
    const consoleDanglingId = objectIdToUuid("6745f6f4a1b2c3d4e5f61004");
    const verifValidId = objectIdToUuid("6745f6f4a1b2c3d4e5f61005");
    const verifDanglingId = objectIdToUuid("6745f6f4a1b2c3d4e5f61006");
    const chatId = objectIdToUuid("6745f6f4a1b2c3d4e5f61007");
    const danglingChatId = objectIdToUuid("6745f6f4a1b2c3d4e5f61097");
    const usageValidId = objectIdToUuid("6745f6f4a1b2c3d4e5f61008");
    const usageDanglingId = objectIdToUuid("6745f6f4a1b2c3d4e5f61009");

    const runValidId = objectIdToUuid("6745f6f4a1b2c3d4e5f6100a");

    await pg.query(
      `INSERT INTO users (id, email) VALUES ($1, 'full-schema@example.com')`,
      [userId],
    );
    await pg.query(
      `INSERT INTO workspaces (id, name, slug, created_by, billing_subscription_status)
       VALUES ($1, 'Full Schema WS', 'full-schema-ws', $2, 'paused')`,
      [wsId, userId],
    );
    await pg.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at, active_workspace_id)
       VALUES ('tok_valid', $1, now() + interval '1 day', $2),
              ('tok_dangling', $1, now() + interval '1 day', $3)`,
      [userId, wsId, danglingWsId],
    );
    await pg.query(
      `INSERT INTO database_connections (id, workspace_id, name, type, connection_encrypted, created_by)
       VALUES ($1, $2, 'Primary DB', 'postgresql', '{}'::jsonb, $3)`,
      [connId, wsId, userId],
    );
    await pg.query(
      `INSERT INTO saved_consoles (id, workspace_id, connection_id, name, code, language, created_by)
       VALUES ($1, $2, $3, 'Valid Console', 'SELECT 1', 'sql', $4),
              ($5, $2, $6, 'Dangling Console', 'SELECT 2', 'sql', $4)`,
      [consoleValidId, wsId, connId, userId, consoleDanglingId, danglingConnId],
    );
    await pg.query(
      `INSERT INTO scheduled_query_runs (id, workspace_id, console_id, status, trigger_type)
       VALUES ($1, $2, $3, 'success', 'schedule')`,
      [runValidId, wsId, consoleValidId],
    );
    await pg.query(
      `INSERT INTO connection_verifications (id, workspace_id, connection_id, database_type, trigger, success, duration_ms)
       VALUES ($1, $2, $3, 'postgresql', 'saved_test', true, 12),
              ($4, $2, $5, 'postgresql', 'saved_test', false, 20)`,
      [verifValidId, wsId, connId, verifDanglingId, danglingConnId],
    );
    await pg.query(
      `INSERT INTO chats (id, workspace_id, created_by, title)
       VALUES ($1, $2, $3, 'Schema Check Chat')`,
      [chatId, wsId, userId],
    );
    await pg.query(
      `INSERT INTO llm_usage (id, workspace_id, user_id, chat_id, invocation_type, model_id, input_tokens, output_tokens, total_tokens, cost_usd)
       VALUES ($1, $2, $3, $4, 'chat', 'claude-sonnet', 10, 20, 30, 0.001),
              ($5, $2, $3, $6, 'chat', 'claude-sonnet', 10, 20, 30, 0.001)`,
      [usageValidId, wsId, userId, chatId, usageDanglingId, danglingChatId],
    );

    // Precondition guard refuses sessions-active-workspace-fk before workspaces_core backfill completes.
    await expect(
      runPostBackfillStep(db, "sessions-active-workspace-fk"),
    ).rejects.toThrow(/workspaces_core backfill status/);

    // Mark workspaces_core global backfill completed (also exercises 0001 lease_token + quarantine unique index).
    await pg.query(
      `INSERT INTO migration_backfill_jobs (domain, scope_key, status, lease_token)
       VALUES ('workspaces_core', 'global', 'completed', NULL)`,
    );
    const quarantineIdx = await pg.query<{ indexname: string }>(
      `SELECT indexname
         FROM pg_indexes
        WHERE schemaname = 'public'
          AND indexname = 'uq_migration_quarantine_unresolved'`,
    );
    expect(quarantineIdx.rows).toHaveLength(1);

    // Run every deferred post-backfill step twice to confirm idempotency.
    for (const { step } of EXPECTED_POST_BACKFILL) {
      const first = await runPostBackfillStep(db, step);
      const second = await runPostBackfillStep(db, step);
      expect(first.statements).toBe(3);
      expect(second.statements).toBe(3);
    }

    // All 4 FK constraints exist and are validated.
    const fkRows = await pg.query<{ conname: string; convalidated: boolean }>(
      `SELECT conname, convalidated
         FROM pg_constraint
        WHERE conname = ANY($1::text[])
        ORDER BY conname`,
      [EXPECTED_POST_BACKFILL.map(e => e.constraint)],
    );
    expect(fkRows.rows).toEqual(
      [...EXPECTED_POST_BACKFILL]
        .sort((a, b) => a.constraint.localeCompare(b.constraint))
        .map(e => ({ conname: e.constraint, convalidated: true })),
    );

    // Dangling refs were nulled, valid refs preserved.
    const sessionCheck = await pg.query<{
      token_hash: string;
      active_workspace_id: string | null;
    }>(
      `SELECT token_hash, active_workspace_id FROM sessions ORDER BY token_hash`,
    );
    expect(sessionCheck.rows).toEqual([
      { token_hash: "tok_dangling", active_workspace_id: null },
      { token_hash: "tok_valid", active_workspace_id: wsId },
    ]);

    const consoleCheck = await pg.query<{
      id: string;
      connection_id: string | null;
    }>(
      `SELECT id::text, connection_id::text FROM saved_consoles ORDER BY name`,
    );
    expect(consoleCheck.rows).toEqual([
      { id: consoleDanglingId, connection_id: null },
      { id: consoleValidId, connection_id: connId },
    ]);

    const verifCheck = await pg.query<{
      id: string;
      connection_id: string | null;
    }>(
      `SELECT id::text, connection_id::text FROM connection_verifications ORDER BY id`,
    );
    expect(verifCheck.rows).toEqual([
      { id: verifValidId, connection_id: connId },
      { id: verifDanglingId, connection_id: null },
    ]);

    const usageCheck = await pg.query<{
      id: string;
      chat_id: string | null;
    }>(`SELECT id::text, chat_id::text FROM llm_usage ORDER BY id`);
    expect(usageCheck.rows).toEqual([
      { id: usageValidId, chat_id: chatId },
      { id: usageDanglingId, chat_id: null },
    ]);

    // ON DELETE SET NULL verified on live parent deletes.
    await pg.query(`DELETE FROM database_connections WHERE id = $1`, [connId]);
    await pg.query(`DELETE FROM chats WHERE id = $1`, [chatId]);

    const postDeleteConsole = await pg.query<{ connection_id: string | null }>(
      `SELECT connection_id FROM saved_consoles WHERE id = $1`,
      [consoleValidId],
    );
    expect(postDeleteConsole.rows[0].connection_id).toBeNull();

    const postDeleteVerif = await pg.query<{ connection_id: string | null }>(
      `SELECT connection_id FROM connection_verifications WHERE id = $1`,
      [verifValidId],
    );
    expect(postDeleteVerif.rows[0].connection_id).toBeNull();

    const postDeleteUsage = await pg.query<{ chat_id: string | null }>(
      `SELECT chat_id FROM llm_usage WHERE id = $1`,
      [usageValidId],
    );
    expect(postDeleteUsage.rows[0].chat_id).toBeNull();

    // 0005 soft ref: deleting saved_consoles preserves scheduled_query_runs history.
    await pg.query(`DELETE FROM saved_consoles WHERE id = $1`, [
      consoleValidId,
    ]);
    const postDeleteRun = await pg.query<{ console_id: string }>(
      `SELECT console_id::text FROM scheduled_query_runs WHERE id = $1`,
      [runValidId],
    );
    expect(postDeleteRun.rows).toEqual([{ console_id: consoleValidId }]);

    await pg.query(`DELETE FROM workspaces WHERE id = $1`, [wsId]);
    const postDeleteSession = await pg.query<{
      active_workspace_id: string | null;
    }>(
      `SELECT active_workspace_id FROM sessions WHERE token_hash = 'tok_valid'`,
    );
    expect(postDeleteSession.rows[0].active_workspace_id).toBeNull();

    // 0006 soft ref: deleting workspaces preserves llm_usage billing audit rows.
    const postDeleteLlmUsage = await pg.query<{ id: string }>(
      `SELECT id::text FROM llm_usage WHERE id = $1`,
      [usageValidId],
    );
    expect(postDeleteLlmUsage.rows).toEqual([{ id: usageValidId }]);
  });

  it("sets DEFAULT uuidv7() on all 51 UUID-PK tables and generates valid RFC 9562 UUIDv7 rows", async () => {
    const defaultsRes = await pg.query<{
      table_name: string;
      column_default: string | null;
    }>(
      `SELECT table_name, column_default
         FROM information_schema.columns
        WHERE table_schema = 'public'
          AND column_name = 'id'
          AND data_type = 'uuid'
        ORDER BY table_name`,
    );
    expect(defaultsRes.rows).toHaveLength(51);
    for (const row of defaultsRes.rows) {
      expect(row.column_default, `${row.table_name}.id default`).toMatch(
        /uuidv7\(\)/i,
      );
    }

    const beforeMs = Date.now() - 5000;
    const userRow = await pg.query<{ id: string }>(
      `INSERT INTO users (email) VALUES ('uuidv7-default@example.com') RETURNING id::text`,
    );
    const wsRow = await pg.query<{ id: string }>(
      `INSERT INTO workspaces (name, slug, created_by)
       VALUES ('UUIDv7 Default WS', 'uuidv7-default-ws', $1)
       RETURNING id::text`,
      [userRow.rows[0].id],
    );
    const memberRow = await pg.query<{ id: string }>(
      `INSERT INTO workspace_members (workspace_id, user_id, role)
       VALUES ($1, $2, 'owner')
       RETURNING id::text`,
      [wsRow.rows[0].id, userRow.rows[0].id],
    );
    const quarantineRow = await pg.query<{ id: string }>(
      `INSERT INTO migration_quarantine (domain, collection_name, mongo_id, reason)
       VALUES ('auth', 'users', 'legacy-1', 'test')
       RETURNING id::text`,
    );
    const afterMs = Date.now() + 5000;

    for (const generatedId of [
      userRow.rows[0].id,
      wsRow.rows[0].id,
      memberRow.rows[0].id,
      quarantineRow.rows[0].id,
    ]) {
      expect(isUuidv7(generatedId)).toBe(true);
      const ts = uuidv7Timestamp(generatedId);
      expect(ts).not.toBeNull();
      if (ts) {
        expect(ts.getTime()).toBeGreaterThanOrEqual(beforeMs);
        expect(ts.getTime()).toBeLessThanOrEqual(afterMs);
      }
    }
  });
});

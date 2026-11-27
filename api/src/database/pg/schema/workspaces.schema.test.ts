import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { migrate as drizzlePgliteMigrate } from "drizzle-orm/pglite/migrator";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { MakoPgDb } from "../client";
import {
  generateUuidv7,
  legacyUserIdToUuidv7,
  objectIdToUuid,
} from "../id-codec";
import { resolveMigrationsFolder } from "../migrate";
import {
  POST_BACKFILL_STEPS,
  readPostBackfillStatements,
  runPostBackfillStep,
} from "../post-backfill";
import { createTestPglite } from "../test-pglite";
import * as schema from "./index";

/**
 * 0003_phase1_workspaces: applies via the real Drizzle migrator on top of
 * 0000–0002, enforces all Decision #3 UUID user FK invariants across the 10
 * tables (including `github_installations`), and verifies the deferred
 * `sessions.active_workspace_id` FK post-backfill step.
 */
describe("0003_phase1_workspaces schema", () => {
  let pg: PGlite;
  let db: MakoPgDb;

  const user1 = legacyUserIdToUuidv7(
    "u_lucia_15chars",
    new Date("2025-01-01T00:00:00Z"),
  );
  const user2 = generateUuidv7();
  const user3 = generateUuidv7();
  const ws1 = objectIdToUuid("6745f6f4a1b2c3d4e5f60718");
  const ws2 = objectIdToUuid("6745f6f4a1b2c3d4e5f60719");

  beforeAll(async () => {
    pg = createTestPglite();
    db = drizzle(pg, { schema }) as unknown as MakoPgDb;
    const migrationsFolder = resolveMigrationsFolder();
    await drizzlePgliteMigrate(drizzle(pg), { migrationsFolder });
    // Idempotent second run.
    await drizzlePgliteMigrate(drizzle(pg), { migrationsFolder });
    await pg.query(
      `INSERT INTO users (id, legacy_id, email) VALUES
        ($1, 'u_lucia_15chars', 'a@example.com'),
        ($2, $3, 'b@example.com'),
        ($4, $5, 'c@example.com')`,
      [user1, user2, user2, user3, user3],
    );
  });

  afterAll(async () => {
    await pg.close();
  });

  it("creates all 10 tables and accepts NULL audit creators for system/legacy rows", async () => {
    const res = await pg.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
        WHERE table_schema = 'public'
          AND table_name IN (
            'workspaces', 'workspace_api_keys', 'workspace_members',
            'workspace_invites', 'workspace_user_handles', 'mcp_oauth_clients',
            'mcp_oauth_codes', 'mcp_oauth_tokens', 'acp_plan_grants',
            'github_installations'
          )
        ORDER BY table_name`,
    );
    expect(res.rows).toHaveLength(10);

    // created_by is nullable UUID FK (NULL allowed for legacy "system"/deleted creators).
    await pg.query(
      `INSERT INTO workspaces (id, name, slug, created_by)
       VALUES ($1, 'One', 'one', NULL), ($2, 'Two', 'two', $3)`,
      [ws1, ws2, user1],
    );
    const row = await pg.query<{
      billing_hard_limit_usd: number | null;
      settings_disabled_model_ids: string[];
      workspace_repos: unknown;
      workflows_active: string[] | null;
    }>(
      `SELECT billing_hard_limit_usd, settings_disabled_model_ids, workspace_repos, workflows_active
         FROM workspaces WHERE id = $1`,
      [ws1],
    );
    expect(row.rows[0].billing_hard_limit_usd).toBe(5);
    expect(row.rows[0].settings_disabled_model_ids).toEqual([]);
    expect(row.rows[0].workspace_repos).toBeNull();
    expect(row.rows[0].workflows_active).toBeNull();
  });

  it("round-trips fractional USD amounts losslessly and keeps NULL hard limit distinct", async () => {
    await pg.query(
      `UPDATE workspaces SET billing_usage_quota_usd = 12.345678, billing_hard_limit_usd = NULL WHERE id = $1`,
      [ws1],
    );
    const r = await pg.query<{ q: number; h: number | null }>(
      `SELECT billing_usage_quota_usd AS q, billing_hard_limit_usd AS h FROM workspaces WHERE id = $1`,
      [ws1],
    );
    expect(r.rows[0].q).toBe(12.345678);
    expect(r.rows[0].h).toBeNull();
  });

  it("allows all 8 Stripe subscription statuses (including unpaid, paused, incomplete_expired) and rejects unknown ones", async () => {
    for (const status of schema.SUBSCRIPTION_STATUSES) {
      await pg.query(
        `UPDATE workspaces SET billing_subscription_status = $1 WHERE id = $2`,
        [status, ws1],
      );
      const loaded = await pg.query<{ s: string | null }>(
        `SELECT billing_subscription_status AS s FROM workspaces WHERE id = $1`,
        [ws1],
      );
      expect(loaded.rows[0].s).toBe(status);
    }
    await pg.query(
      `UPDATE workspaces SET billing_subscription_status = NULL WHERE id = $1`,
      [ws1],
    );
    await expect(
      pg.query(
        `UPDATE workspaces SET billing_subscription_status = 'bogus_status' WHERE id = $1`,
        [ws1],
      ),
    ).rejects.toThrow(/workspaces_billing_subscription_status_check/);
  });

  it("keeps api key scopes NULL distinct from an empty array and enforces unique key_hash", async () => {
    const k1 = objectIdToUuid("6745f6f4a1b2c3d4e5f60720");
    const k2 = objectIdToUuid("6745f6f4a1b2c3d4e5f60721");
    await pg.query(
      `INSERT INTO workspace_api_keys (id, workspace_id, name, key_hash, prefix, scopes, created_by)
       VALUES ($1, $3, 'legacy', 'hash-1', 'revops_a', NULL, $4),
              ($2, $3, 'scoped', 'hash-2', 'revops_b', '{}', NULL)`,
      [k1, k2, ws1, user1],
    );
    const r = await pg.query<{ name: string; scopes: string[] | null }>(
      `SELECT name, scopes FROM workspace_api_keys WHERE workspace_id = $1 ORDER BY name`,
      [ws1],
    );
    expect(r.rows).toEqual([
      { name: "legacy", scopes: null },
      { name: "scoped", scopes: [] },
    ]);
    await expect(
      pg.query(
        `INSERT INTO workspace_api_keys (id, workspace_id, name, key_hash, prefix, created_by)
         VALUES ($1, $2, 'dup', 'hash-1', 'revops_c', $3)`,
        [objectIdToUuid("6745f6f4a1b2c3d4e5f60722"), ws1, user1],
      ),
    ).rejects.toThrow(/uq_workspace_api_keys_key_hash/);
  });

  it("enforces one default membership per user and UUID FK to users", async () => {
    await pg.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role, is_default_membership)
       VALUES ($1, $2, $3, 'owner', true)`,
      [objectIdToUuid("6745f6f4a1b2c3d4e5f60730"), ws1, user1],
    );
    await expect(
      pg.query(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role, is_default_membership)
         VALUES ($1, $2, $3, 'owner', true)`,
        [objectIdToUuid("6745f6f4a1b2c3d4e5f60731"), ws2, user1],
      ),
    ).rejects.toThrow(/uq_workspace_members_default/);
    // Non-default membership in a second workspace is fine.
    await pg.query(
      `INSERT INTO workspace_members (id, workspace_id, user_id, role)
       VALUES ($1, $2, $3, 'member')`,
      [objectIdToUuid("6745f6f4a1b2c3d4e5f60732"), ws2, user1],
    );
    await expect(
      pg.query(
        `INSERT INTO workspace_members (id, workspace_id, user_id, role)
         VALUES ($1, $2, $3, 'member')`,
        [objectIdToUuid("6745f6f4a1b2c3d4e5f60733"), ws2, generateUuidv7()],
      ),
    ).rejects.toThrow(/foreign key/i);
  });

  it("enforces github_installations bigint installation_id, checks, and unique (workspace_id, installation_id)", async () => {
    const bigInstId = 5_000_000_123; // exceeds int32
    const g1 = objectIdToUuid("6745f6f4a1b2c3d4e5f60750");
    const g2 = objectIdToUuid("6745f6f4a1b2c3d4e5f60751");
    await pg.query(
      `INSERT INTO github_installations (id, workspace_id, installation_id, account_login, account_type, repository_selection, created_by)
       VALUES ($1, $2, $3, 'realadvisor', 'Organization', 'selected', $4)`,
      [g1, ws1, bigInstId, user1],
    );
    const loaded = await pg.query<{
      installation_id: string;
      account_login: string;
      account_type: string;
      repository_selection: string;
    }>(
      `SELECT installation_id::text, account_login, account_type, repository_selection
         FROM github_installations WHERE id = $1`,
      [g1],
    );
    expect(loaded.rows[0]).toEqual({
      installation_id: String(bigInstId),
      account_login: "realadvisor",
      account_type: "Organization",
      repository_selection: "selected",
    });
    await expect(
      pg.query(
        `INSERT INTO github_installations (id, workspace_id, installation_id, account_login)
         VALUES ($1, $2, $3, 'realadvisor')`,
        [g2, ws1, bigInstId],
      ),
    ).rejects.toThrow(/uq_github_installations_ws_inst/);
  });

  it("keeps handles reserved (user_id -> NULL) on user deletion and cascades workspace deletion", async () => {
    const ws3 = objectIdToUuid("6745f6f4a1b2c3d4e5f60740");
    await pg.query(
      `INSERT INTO workspaces (id, name, slug, created_by) VALUES ($1, 'Three', 'three', $2)`,
      [ws3, user2],
    );
    await pg.query(
      `INSERT INTO mcp_oauth_clients (id, client_id, redirect_uris) VALUES ($1, 'mcpc_test', ARRAY['http://localhost/cb'])`,
      [objectIdToUuid("6745f6f4a1b2c3d4e5f60741")],
    );
    await pg.query(
      `INSERT INTO workspace_user_handles (id, workspace_id, user_id, handle) VALUES
        ($1, $3, $4, 'alice'),
        ($2, $3, $5, 'bob')`,
      [
        objectIdToUuid("6745f6f4a1b2c3d4e5f60742"),
        objectIdToUuid("6745f6f4a1b2c3d4e5f60746"),
        ws3,
        user2,
        user3,
      ],
    );
    await pg.query(
      `INSERT INTO mcp_oauth_tokens (id, access_token_hash, refresh_token_hash, client_id, user_id, workspace_id, scopes, access_expires_at)
       VALUES ($1, 'at', 'rt', 'mcpc_test', $2, $3, ARRAY['query:read'], now() + interval '1 hour')`,
      [objectIdToUuid("6745f6f4a1b2c3d4e5f60743"), user1, ws3],
    );
    await pg.query(
      `INSERT INTO acp_plan_grants (id, workspace_id, user_id, agent_session_id, plan_digest, grants, status, expires_at)
       VALUES ($1, $2, $3, 'sess-1', 'digest', ARRAY['git-write'], 'approved', now() + interval '1 hour')`,
      [objectIdToUuid("6745f6f4a1b2c3d4e5f60744"), ws3, user1],
    );
    await pg.query(
      `INSERT INTO github_installations (id, workspace_id, installation_id, account_login, created_by)
       VALUES ($1, $2, 99999, 'acme', $3)`,
      [objectIdToUuid("6745f6f4a1b2c3d4e5f60745"), ws3, user2],
    );

    // Deleting user2 and user3 nulls handles' user_id & created_by while keeping both handles reserved!
    await pg.query(`DELETE FROM users WHERE id IN ($1, $2)`, [user2, user3]);
    const handles = await pg.query<{
      handle: string;
      user_id: string | null;
    }>(
      `SELECT handle, user_id FROM workspace_user_handles WHERE workspace_id = $1 ORDER BY handle`,
      [ws3],
    );
    expect(handles.rows).toEqual([
      { handle: "alice", user_id: null },
      { handle: "bob", user_id: null },
    ]);

    // Deleting the workspace cascades every child table.
    await pg.query(`DELETE FROM workspaces WHERE id = $1`, [ws3]);
    for (const t of [
      "workspace_user_handles",
      "mcp_oauth_tokens",
      "acp_plan_grants",
      "github_installations",
    ]) {
      const r = await pg.query<{ n: number }>(
        `SELECT count(*)::int AS n FROM ${t} WHERE workspace_id = $1`,
        [ws3],
      );
      expect(r.rows[0].n).toBe(0);
    }
  });

  it("enforces workspaces_core completion + clean quarantine precondition before attaching sessions.active_workspace_id FK (overridable with force)", async () => {
    expect(POST_BACKFILL_STEPS.map(s => s.name)).toContain(
      "sessions-active-workspace-fk",
    );
    expect(
      readPostBackfillStatements("sessions-active-workspace-fk").length,
    ).toBe(3);

    const dangling = objectIdToUuid("6745f6f4a1b2c3d4e5f60799");
    await pg.query(
      `INSERT INTO sessions (token_hash, user_id, expires_at, active_workspace_id) VALUES
        ('hash_valid', $1, now() + interval '1 day', $2),
        ('hash_dangling', $1, now() + interval '1 day', $3)`,
      [user1, ws1, dangling],
    );

    // 1. Refuses when workspaces_core backfill has not started — and does NOT clear sessions!
    await expect(
      runPostBackfillStep(db, "sessions-active-workspace-fk"),
    ).rejects.toThrow(/not_started/);
    const stillIntact = await pg.query<{
      token_hash: string;
      active_workspace_id: string | null;
    }>(
      `SELECT token_hash, active_workspace_id FROM sessions WHERE token_hash = 'hash_dangling'`,
    );
    expect(stillIntact.rows[0].active_workspace_id).toBe(dangling);

    // 2. Refuses when workspaces_core backfill is running / paused / failed.
    for (const status of ["running", "paused", "failed"] as const) {
      await pg.query(
        `INSERT INTO migration_backfill_jobs (domain, scope_key, status)
         VALUES ('workspaces_core', 'global', $1)
         ON CONFLICT (domain, scope_key) DO UPDATE SET status = EXCLUDED.status`,
        [status],
      );
      await expect(
        runPostBackfillStep(db, "sessions-active-workspace-fk"),
      ).rejects.toThrow(new RegExp(status));
    }

    // 3. Refuses when backfill is completed but an unresolved workspace row is quarantined.
    await pg.query(
      `UPDATE migration_backfill_jobs SET status = 'completed', completed_at = now()
        WHERE domain = 'workspaces_core' AND scope_key = 'global'`,
    );
    await pg.query(
      `INSERT INTO migration_quarantine (domain, collection_name, mongo_id, reason)
       VALUES ('workspaces_core', 'workspaces', '6745f6f4a1b2c3d4e5f60799', 'invalid_workspace_missing_slug')`,
    );
    await expect(
      runPostBackfillStep(db, "sessions-active-workspace-fk"),
    ).rejects.toThrow(/quarantined/);
    // Still untouched!
    expect(
      (
        await pg.query<{ active_workspace_id: string | null }>(
          `SELECT active_workspace_id FROM sessions WHERE token_hash = 'hash_dangling'`,
        )
      ).rows[0].active_workspace_id,
    ).toBe(dangling);

    // 4. Explicit `force: true` overrides the precondition (and works idempotently).
    //    Also verify resolving quarantine allows running WITHOUT `force`.
    await runPostBackfillStep(db, "sessions-active-workspace-fk", {
      force: true,
    });
    await pg.query(
      `UPDATE migration_quarantine SET resolved_at = now() WHERE domain = 'workspaces_core'`,
    );
    await runPostBackfillStep(db, "sessions-active-workspace-fk");

    const r = await pg.query<{
      token_hash: string;
      active_workspace_id: string | null;
    }>(
      `SELECT token_hash, active_workspace_id FROM sessions ORDER BY token_hash`,
    );
    expect(r.rows).toEqual([
      { token_hash: "hash_dangling", active_workspace_id: null },
      { token_hash: "hash_valid", active_workspace_id: ws1 },
    ]);

    // ON DELETE SET NULL now applies.
    await pg.query(`DELETE FROM workspaces WHERE id = $1`, [ws1]);
    const after = await pg.query<{ active_workspace_id: string | null }>(
      `SELECT active_workspace_id FROM sessions WHERE token_hash = 'hash_valid'`,
    );
    expect(after.rows[0].active_workspace_id).toBeNull();
  });
});

import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MakoPgDb } from "./client";
import { runPgliteMigrations } from "./migrate";
import * as schema from "./schema";
import { createTestPglite } from "./test-pglite";
import {
  assertSafeSqlIdentifier,
  clearTtlRegistryForTests,
  DEFAULT_PG_TTL_RULES,
  listTtlRules,
  reapAllRegisteredTables,
  reapAllRegisteredTablesOrThrow,
  reapExpiredRows,
  registerDefaultPgTtlRules,
  registerTtlRule,
} from "./ttl-reaper";

describe("ttl-reaper (batched ctid expiration)", () => {
  let pg: PGlite;
  let db: MakoPgDb;

  beforeAll(async () => {
    pg = createTestPglite();
    await runPgliteMigrations(pg);
    await pg.exec(`
      CREATE TABLE test_ttl_tokens (
        id serial PRIMARY KEY,
        expires_at timestamptz
      );
      CREATE TABLE test_ttl_events (
        id serial PRIMARY KEY,
        created_at timestamptz NOT NULL
      );
    `);
    db = drizzle(pg, { schema }) as unknown as MakoPgDb;
  });

  beforeEach(async () => {
    clearTtlRegistryForTests();
    await pg.exec("DELETE FROM test_ttl_tokens; DELETE FROM test_ttl_events;");
  });

  afterAll(async () => {
    await pg.close();
  });

  it("registers all 18 default platform Postgres TTL rules and executes cleanly against migrated schema", async () => {
    registerDefaultPgTtlRules();
    const rules = listTtlRules();
    expect(rules).toHaveLength(DEFAULT_PG_TTL_RULES.length);
    const names = new Set(rules.map(r => r.tableName));
    // Blob-owning & permanent ledger tables must NEVER be auto-reaped
    expect(names.has("app_binding_drafts")).toBe(false);
    expect(names.has("app_binding_jobs")).toBe(false);
    expect(names.has("llm_usage")).toBe(false);
    expect(names.has("app_usage_daily")).toBe(false);
    expect(names.has("connection_access_events")).toBe(false);
    expect(rules).toHaveLength(18);
    expect(names.has("notification_deliveries")).toBe(true);
    expect(names.has("workflow_recorded_writes")).toBe(true);
    expect(names.has("workflow_recorded_runs")).toBe(true);

    const outcome = await reapAllRegisteredTablesOrThrow({ db });
    expect(outcome.errors).toEqual({});
    expect(outcome.results).toHaveLength(DEFAULT_PG_TTL_RULES.length);
  });

  it("deletes expired rows in bounded ctid batches and leaves active/NULL rows untouched", async () => {
    const now = new Date("2026-11-26T18:00:00.000Z");

    for (let i = 0; i < 8; i++) {
      await pg.query(
        `INSERT INTO test_ttl_tokens (expires_at) VALUES ($1::timestamptz)`,
        [new Date(now.getTime() - (i + 1) * 60_000).toISOString()],
      );
    }
    await pg.query(
      `INSERT INTO test_ttl_tokens (expires_at) VALUES ($1::timestamptz), ($2::timestamptz), (NULL)`,
      [
        new Date(now.getTime() + 60_000).toISOString(),
        new Date(now.getTime() + 3_600_000).toISOString(),
      ],
    );

    const run1 = await reapExpiredRows(
      {
        tableName: "test_ttl_tokens",
        timestampColumn: "expires_at",
        batchSize: 3,
        maxBatchesPerRun: 2,
      },
      { db, now },
    );
    expect(run1.deleted).toBe(6);
    expect(run1.batches).toBe(2);
    expect(run1.hitBatchCap).toBe(true);

    const run2 = await reapExpiredRows(
      {
        tableName: "test_ttl_tokens",
        timestampColumn: "expires_at",
        batchSize: 3,
        maxBatchesPerRun: 5,
      },
      { db, now },
    );
    expect(run2.deleted).toBe(2);
    expect(run2.batches).toBe(1);
    expect(run2.hitBatchCap).toBe(false);

    const remaining = await pg.query("SELECT * FROM test_ttl_tokens");
    expect(remaining.rows).toHaveLength(3);
  });

  it("supports age-based olderThanMs retention and isolates errors across registered tables", async () => {
    const now = new Date("2026-11-26T18:00:00.000Z");
    const dayMs = 24 * 60 * 60 * 1000;

    await pg.query(
      `INSERT INTO test_ttl_events (created_at) VALUES ($1::timestamptz), ($2::timestamptz), ($3::timestamptz)`,
      [
        new Date(now.getTime() - 95 * dayMs).toISOString(),
        new Date(now.getTime() - 91 * dayMs).toISOString(),
        new Date(now.getTime() - 10 * dayMs).toISOString(),
      ],
    );

    registerTtlRule({
      tableName: "test_ttl_events",
      timestampColumn: "created_at",
      olderThanMs: 90 * dayMs,
      batchSize: 100,
    });
    registerTtlRule({
      tableName: "nonexistent_table_xyz",
      timestampColumn: "expires_at",
    });

    const { results, errors } = await reapAllRegisteredTables({ db, now });
    expect(results).toHaveLength(1);
    expect(results[0].tableName).toBe("test_ttl_events");
    expect(results[0].deleted).toBe(2);
    expect(errors.nonexistent_table_xyz).toBeDefined();

    const remaining = await pg.query("SELECT * FROM test_ttl_events");
    expect(remaining.rows).toHaveLength(1);
  });

  it("rejects unsafe SQL identifiers", () => {
    expect(() =>
      assertSafeSqlIdentifier("valid_table_1", "tableName"),
    ).not.toThrow();
    expect(() =>
      assertSafeSqlIdentifier("users; DROP TABLE users", "tableName"),
    ).toThrow(/Unsafe SQL/);
    expect(() => assertSafeSqlIdentifier("UpperCase", "tableName")).toThrow(
      /Unsafe SQL/,
    );
    expect(() =>
      assertSafeSqlIdentifier("1leading_digit", "tableName"),
    ).toThrow(/Unsafe SQL/);
  });

  it("reapAllRegisteredTablesOrThrow reaps healthy tables and throws an aggregated error when any table fails", async () => {
    const now = new Date("2026-11-26T18:00:00.000Z");
    await pg.query(
      `INSERT INTO test_ttl_tokens (expires_at) VALUES ($1::timestamptz), ($2::timestamptz)`,
      [
        new Date(now.getTime() - 60_000).toISOString(),
        new Date(now.getTime() + 60_000).toISOString(),
      ],
    );

    registerTtlRule({
      tableName: "missing_broken_table",
      timestampColumn: "expires_at",
    });
    registerTtlRule({
      tableName: "test_ttl_tokens",
      timestampColumn: "expires_at",
    });

    await expect(reapAllRegisteredTablesOrThrow({ db, now })).rejects.toThrow(
      /missing_broken_table/,
    );

    const remaining = await pg.query("SELECT * FROM test_ttl_tokens");
    expect(remaining.rows).toHaveLength(1);
  });
});

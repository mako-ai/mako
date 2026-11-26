import type { PGlite } from "@electric-sql/pglite";
import { drizzle } from "drizzle-orm/pglite";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MakoPgDb } from "../database/pg/client";
import { runPgliteMigrations } from "../database/pg/migrate";
import * as schema from "../database/pg/schema";
import { createTestPglite } from "../database/pg/test-pglite";
import {
  assertSafeSqlIdentifier,
  clearTtlRegistryForTests,
  reapAllRegisteredTables,
  reapExpiredRows,
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

  it("deletes expired rows in bounded ctid batches and leaves active/NULL rows untouched", async () => {
    const now = new Date("2026-11-26T18:00:00.000Z");

    // Insert 8 expired tokens, 2 active tokens, and 1 NULL-expiry token
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

    // Cap at 2 batches of 3 = 6 deleted
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

    // Next run clears the remaining 2 expired rows and stops cleanly
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

    // 2 active + 1 NULL remain
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
});

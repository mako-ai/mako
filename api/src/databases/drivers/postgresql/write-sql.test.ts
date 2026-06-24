import { describe, it, expect, beforeEach } from "vitest";
import { PostgreSQLDatabaseDriver } from "./driver";
import {
  makeCapturingDriver,
  makeFakeConnection,
  normalizeSql,
  type CapturingDriver,
} from "../../test-support";

/**
 * Write-SQL unit tests for the PostgreSQL driver. Drivers build SQL then call
 * `this.executeQuery`, so capturing that call asserts the generated SQL with no
 * database. Catches identifier-quoting / conflict-clause / staging-swap
 * regressions.
 */

const conn = makeFakeConnection("postgresql", { database: "app" });

describe("PostgreSQLDatabaseDriver write SQL", () => {
  let cap: CapturingDriver<PostgreSQLDatabaseDriver>;
  let pg: PostgreSQLDatabaseDriver;

  const setup = (responder?: Parameters<typeof makeCapturingDriver>[1]) => {
    pg = new PostgreSQLDatabaseDriver();
    cap = makeCapturingDriver(pg, responder);
  };

  beforeEach(() => setup());

  it("createTable quotes identifiers and renders constraints", async () => {
    await pg.createTable(
      conn,
      "users",
      [
        { name: "id", type: "INTEGER", primaryKey: true },
        { name: "email", type: "TEXT", nullable: false },
        { name: "bio", type: "TEXT", nullable: true },
      ],
      { schema: "public" },
    );
    const sql = normalizeSql(cap.lastSql() ?? "");
    expect(sql).toContain('CREATE TABLE IF NOT EXISTS "public"."users"');
    expect(sql).toContain('"id" INTEGER PRIMARY KEY');
    expect(sql).toContain('"email" TEXT NOT NULL');
    expect(sql).toContain('"bio" TEXT');
    expect(sql).not.toContain('"bio" TEXT NOT NULL');
  });

  it("insertBatch builds a multi-row VALUES statement with escaped literals", async () => {
    await pg.insertBatch(
      conn,
      "users",
      [
        { id: 1, email: "a@b.com", active: true },
        { id: 2, email: "o'brien@x.com", active: false },
      ],
      { schema: "public" },
    );
    const sql = normalizeSql(cap.lastSql() ?? "");
    expect(sql).toContain(
      'INSERT INTO "public"."users" ("id", "email", "active") VALUES',
    );
    expect(sql).toContain("(1, 'a@b.com', TRUE)");
    // single quote in value is doubled
    expect(sql).toContain("(2, 'o''brien@x.com', FALSE)");
  });

  it("upsertBatch emits ON CONFLICT DO UPDATE and ensures a unique index first", async () => {
    // Default responder returns no rows → driver creates the conflict index.
    await pg.upsertBatch(conn, "users", [{ id: 1, email: "a@b.com" }], ["id"], {
      schema: "public",
    });
    const all = cap.sql().map(normalizeSql);
    // index existence probe + creation happen before the upsert
    expect(all.some(s => s.includes("CREATE UNIQUE INDEX IF NOT EXISTS"))).toBe(
      true,
    );
    const upsert = all.find(s => s.startsWith("INSERT INTO")) ?? "";
    expect(upsert).toContain('ON CONFLICT ("id") DO UPDATE SET');
    expect(upsert).toContain('"email" = EXCLUDED."email"');
    // key column is not in the update set
    expect(upsert).not.toContain('"id" = EXCLUDED."id"');
  });

  it("upsertBatch with conflictStrategy=ignore emits DO NOTHING and skips the index", async () => {
    await pg.upsertBatch(conn, "users", [{ id: 1, email: "a@b.com" }], ["id"], {
      schema: "public",
      conflictStrategy: "ignore",
    });
    const all = cap.sql().map(normalizeSql);
    expect(all.some(s => s.includes("CREATE UNIQUE INDEX"))).toBe(false);
    expect(all.some(s => s.includes('ON CONFLICT ("id") DO NOTHING'))).toBe(
      true,
    );
  });

  it("createStagingTable drops then clones the original structure", async () => {
    await pg.createStagingTable(conn, "users", "users_stg", {
      schema: "public",
    });
    const all = cap.sql().map(normalizeSql);
    expect(all[0]).toBe('DROP TABLE IF EXISTS "public"."users_stg";');
    expect(all[1]).toContain(
      'CREATE TABLE "public"."users_stg" (LIKE "public"."users" INCLUDING ALL)',
    );
  });

  it("swapStagingTable renames atomically inside a transaction", async () => {
    await pg.swapStagingTable(conn, "users", "users_stg", { schema: "public" });
    const sql = normalizeSql(cap.lastSql() ?? "");
    expect(sql).toContain("BEGIN;");
    expect(sql).toContain('ALTER TABLE IF EXISTS "public"."users" RENAME TO');
    expect(sql).toContain('ALTER TABLE "public"."users_stg" RENAME TO "users"');
    expect(sql).toContain("COMMIT;");
  });

  it("dropTable is guarded with IF EXISTS", async () => {
    await pg.dropTable(conn, "users", { schema: "public" });
    expect(normalizeSql(cap.lastSql() ?? "")).toBe(
      'DROP TABLE IF EXISTS "public"."users";',
    );
  });

  it("deleteBatch builds a WHERE clause from key filters (NULL-safe)", async () => {
    await pg.deleteBatch(
      conn,
      "users",
      { id: 5, tenant: null },
      { schema: "public" },
    );
    const sql = normalizeSql(cap.lastSql() ?? "");
    expect(sql).toContain('DELETE FROM "public"."users" WHERE');
    expect(sql).toContain('"id" = 5');
    expect(sql).toContain('"tenant" IS NULL');
  });

  it("addMissingColumns issues ALTER ADD COLUMN for keys not already present", async () => {
    // Responder: existing-columns probe returns only `id`.
    setup(sql => {
      if (sql.includes("information_schema.columns")) {
        return { success: true, data: [{ column_name: "id" }] };
      }
      return { success: true, data: [] };
    });
    await pg.addMissingColumns(conn, "users", "public", [
      { id: 1, email: "a@b.com", created_at: "2026-01-01T00:00:00Z" },
    ]);
    const alters = cap
      .sql()
      .map(normalizeSql)
      .filter(s => s.startsWith("ALTER TABLE"));
    expect(alters.length).toBe(2); // email + created_at, not id
    expect(
      alters.some(s => s.includes('ADD COLUMN IF NOT EXISTS "email"')),
    ).toBe(true);
    expect(
      alters.some(s => s.includes('ADD COLUMN IF NOT EXISTS "created_at"')),
    ).toBe(true);
    expect(alters.some(s => s.includes('"id"'))).toBe(false);
  });
});

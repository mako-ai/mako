import { describe, it, expect, beforeAll, afterAll } from "vitest";
import {
  PostgreSqlContainer,
  type StartedPostgreSqlContainer,
} from "@testcontainers/postgresql";
import { PostgreSQLDatabaseDriver } from "./driver";
import { databaseConnectionService } from "../../../services/database-connection.service";
import { makeFakeConnection } from "../../test-support";
import type { IDatabaseConnection } from "../../../database/workspace-schema";

/**
 * Gated round-trip integration for the PostgreSQL destination driver against a
 * real Postgres (via testcontainers). Exercises the full sync write lifecycle:
 * createTable -> insertBatch -> upsertBatch (dedupe/update) -> staging swap ->
 * soft-delete purge.
 *
 * Skipped unless RUN_DB_INTEGRATION=1 (requires Docker). Runs in the nightly CI
 * job, not the per-PR offline suite.
 */
const RUN =
  process.env.RUN_DB_INTEGRATION === "1" ||
  process.env.RUN_DB_INTEGRATION === "true";

async function count(
  driver: PostgreSQLDatabaseDriver,
  conn: IDatabaseConnection,
  table: string,
): Promise<number> {
  const res = await driver.executeQuery(
    conn,
    `SELECT COUNT(*)::int AS n FROM "public"."${table}"`,
  );
  return Number((res.data as Array<{ n: number }>)[0]?.n ?? 0);
}

describe.skipIf(!RUN)("PostgreSQL destination round-trip", () => {
  let container: StartedPostgreSqlContainer;
  let conn: IDatabaseConnection;
  const driver = new PostgreSQLDatabaseDriver();

  beforeAll(async () => {
    container = await new PostgreSqlContainer("postgres:16").start();
    conn = makeFakeConnection("postgresql", {
      connectionString: container.getConnectionUri(),
    });
  }, 180_000);

  afterAll(async () => {
    // Best-effort: close pooled connections so the process can exit cleanly.
    await (
      databaseConnectionService as unknown as {
        closeAllConnections?: () => Promise<void>;
      }
    ).closeAllConnections?.();
    if (container) await container.stop();
  });

  it("creates, inserts, upserts (dedupe), swaps staging, and purges soft deletes", async () => {
    const cols = [
      { name: "id", type: "INTEGER", primaryKey: true },
      { name: "email", type: "TEXT", nullable: true },
      { name: "is_deleted", type: "BOOLEAN", nullable: true },
    ];

    const created = await driver.createTable(conn, "users", cols, {
      schema: "public",
    });
    expect(created.success).toBe(true);

    // insert
    const ins = await driver.insertBatch(
      conn,
      "users",
      [
        { id: 1, email: "a@x.com", is_deleted: false },
        { id: 2, email: "b@x.com", is_deleted: false },
      ],
      { schema: "public" },
    );
    expect(ins.success).toBe(true);
    expect(await count(driver, conn, "users")).toBe(2);

    // upsert: update id=1, insert id=3 → 3 rows, email updated
    const ups = await driver.upsertBatch(
      conn,
      "users",
      [
        { id: 1, email: "a2@x.com", is_deleted: false },
        { id: 3, email: "c@x.com", is_deleted: false },
      ],
      ["id"],
      { schema: "public" },
    );
    expect(ups.success).toBe(true);
    expect(await count(driver, conn, "users")).toBe(3);
    const updated = await driver.executeQuery(
      conn,
      `SELECT email FROM "public"."users" WHERE id = 1`,
    );
    expect((updated.data as Array<{ email: string }>)[0]?.email).toBe(
      "a2@x.com",
    );

    // staging swap: build a staging copy with a single row, then swap it in
    const stg = await driver.createStagingTable(conn, "users", "users_stg", {
      schema: "public",
    });
    expect(stg.success).toBe(true);
    await driver.insertBatch(
      conn,
      "users_stg",
      [{ id: 99, email: "staged@x.com", is_deleted: true }],
      { schema: "public" },
    );
    const swap = await driver.swapStagingTable(conn, "users", "users_stg", {
      schema: "public",
    });
    expect(swap.success).toBe(true);
    expect(await count(driver, conn, "users")).toBe(1);

    // soft-delete purge — exactly what purgeSoftDeletesAfterBackfill issues.
    await driver.executeQuery(
      conn,
      `DELETE FROM "public"."users" WHERE is_deleted = true`,
    );
    expect(await count(driver, conn, "users")).toBe(0);
  });
});

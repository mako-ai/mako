import { drizzle, NodePgDatabase } from "drizzle-orm/node-postgres";
import { Pool, PoolConfig } from "pg";

import { loggers } from "../logging";
import * as schema from "./schema";

const log = loggers.db();

/**
 * Postgres connection for Mako's own metadata (the migration target).
 *
 * Resolution order for the connection string:
 *   1. `POSTGRES_URL`     — primary (set this to the Neon URL in prod)
 *   2. `PG_DATABASE_URL`  — alias
 *   3. local default      — `postgres://postgres@127.0.0.1:5432/mako_dev`
 *
 * This is intentionally separate from the Mongo `DATABASE_URL` so the two
 * stores can run side-by-side during the gradual migration.
 */
export function getPostgresUrl(): string {
  return (
    process.env.POSTGRES_URL ||
    process.env.PG_DATABASE_URL ||
    "postgres://postgres@127.0.0.1:5432/mako_dev"
  );
}

export type Database = NodePgDatabase<typeof schema>;

let pool: Pool | null = null;
let dbInstance: Database | null = null;

export function getPool(): Pool {
  if (!pool) {
    const connectionString = getPostgresUrl();
    const config: PoolConfig = {
      connectionString,
      max: Number(process.env.POSTGRES_MAX_POOL_SIZE) || 10,
      idleTimeoutMillis: 30_000,
      connectionTimeoutMillis: 10_000,
    };
    // Neon and most managed Postgres require TLS; enable it for non-local hosts.
    if (
      !/localhost|127\.0\.0\.1/.test(connectionString) &&
      process.env.POSTGRES_SSL !== "false"
    ) {
      config.ssl = { rejectUnauthorized: false };
    }
    pool = new Pool(config);
    pool.on("error", err => {
      log.error("Postgres pool error", { error: err });
    });
  }
  return pool;
}

/** The shared Drizzle instance (lazy, schema-bound). */
export function getDb(): Database {
  if (!dbInstance) {
    dbInstance = drizzle(getPool(), { schema, casing: "snake_case" });
  }
  return dbInstance;
}

/** Verifies connectivity. Returns true on success. */
export async function pingPostgres(): Promise<boolean> {
  const result = await getPool().query("SELECT 1 AS ok");
  return result.rows[0]?.ok === 1;
}

export async function closePostgres(): Promise<void> {
  if (pool) {
    await pool.end();
    pool = null;
    dbInstance = null;
  }
}

export { schema };

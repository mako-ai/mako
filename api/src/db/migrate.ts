/* eslint-disable no-console, no-process-exit */
import path from "node:path";

import { migrate } from "drizzle-orm/node-postgres/migrator";

import { loggers } from "../logging";
import { closePostgres, getDb, getPool } from "./client";

const log = loggers.migration();

const MIGRATIONS_FOLDER = path.join(__dirname, "migrations");

/**
 * Apply all pending Drizzle migrations to the Postgres metadata store.
 *
 * Required extensions are created first because drizzle-kit does not emit
 * `CREATE EXTENSION` (pgvector backs the console/skill embedding columns).
 */
export async function runMigrations(): Promise<void> {
  const pool = getPool();
  await pool.query('CREATE EXTENSION IF NOT EXISTS "uuid-ossp"');
  await pool.query("CREATE EXTENSION IF NOT EXISTS vector");
  await migrate(getDb(), { migrationsFolder: MIGRATIONS_FOLDER });
  log.info("Postgres migrations applied", { folder: MIGRATIONS_FOLDER });
}

// Allow running directly: `tsx src/db/migrate.ts`
if (require.main === module) {
  runMigrations()
    .then(async () => {
      console.log("migrations: OK");
      await closePostgres();
      process.exit(0);
    })
    .catch(async err => {
      console.error("migrations: FAILED", err);
      await closePostgres();
      process.exit(1);
    });
}

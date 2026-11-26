/**
 * Platform Postgres migration runner (Drizzle SQL migrations + PGlite test helper).
 *
 * Guards against missing or empty migration folders before connecting so a
 * mispackaged Docker/CI build fails loudly rather than silently reporting success.
 */
import fs from "node:fs";
import path from "node:path";
import { drizzle } from "drizzle-orm/postgres-js";
import { migrate } from "drizzle-orm/postgres-js/migrator";
import postgres from "postgres";
import { loggers } from "../../logging";
import { isLocalPostgres } from "./client";

const logger = loggers.migration();

export interface MigrationsFolderInfo {
  folder: string;
  tags: string[];
  count: number;
}

interface DrizzleJournal {
  entries?: Array<{ tag?: string }>;
}

/** Resolve the SQL migrations directory adjacent to this file (`src/` or compiled `dist/`). */
export function resolveMigrationsFolder(customFolder?: string): string {
  if (customFolder) {
    return path.resolve(customFolder);
  }
  return path.resolve(__dirname, "migrations");
}

/**
 * Validate that the Drizzle migrations folder exists, has a non-empty `meta/_journal.json`,
 * and every journal entry corresponds to an existing `.sql` file on disk.
 */
export function checkMigrationsFolder(
  customFolder?: string,
): MigrationsFolderInfo {
  const folder = resolveMigrationsFolder(customFolder);
  if (!fs.existsSync(folder) || !fs.statSync(folder).isDirectory()) {
    throw new Error(
      `Postgres migrations folder not found: ${folder}. ` +
        "Ensure api/src/database/pg/migrations/** is bundled into dist/ by api/scripts/copy-build-assets.mjs.",
    );
  }

  const journalPath = path.join(folder, "meta", "_journal.json");
  if (!fs.existsSync(journalPath)) {
    throw new Error(`Drizzle migrations journal missing: ${journalPath}`);
  }

  const rawJournal = JSON.parse(
    fs.readFileSync(journalPath, "utf8"),
  ) as DrizzleJournal;
  const entries = rawJournal.entries ?? [];
  if (entries.length === 0) {
    throw new Error(
      `Drizzle migrations journal has zero entries: ${journalPath}`,
    );
  }

  const tags: string[] = [];
  for (const entry of entries) {
    if (!entry.tag || typeof entry.tag !== "string") {
      throw new Error(`Invalid entry in Drizzle journal ${journalPath}`);
    }
    const sqlFile = path.join(folder, `${entry.tag}.sql`);
    if (!fs.existsSync(sqlFile)) {
      throw new Error(
        `Drizzle journal references missing SQL file: ${sqlFile}`,
      );
    }
    tags.push(entry.tag);
  }

  return { folder, tags, count: tags.length };
}

export interface RunPgMigrationsOptions {
  connectionString?: string;
  migrationsFolder?: string;
}

export interface RunPgMigrationsResult {
  folder: string;
  count: number;
  durationMs: number;
}

/**
 * Run all pending Drizzle SQL migrations against Postgres using a dedicated
 * single-connection `postgres.js` client over `POSTGRES_DIRECT_URL` (fallback `POSTGRES_URL`).
 */
export async function runPgMigrations(
  options: RunPgMigrationsOptions = {},
): Promise<RunPgMigrationsResult> {
  const info = checkMigrationsFolder(options.migrationsFolder);
  const connectionString =
    options.connectionString?.trim() ||
    process.env.POSTGRES_DIRECT_URL?.trim() ||
    process.env.POSTGRES_URL?.trim();

  if (!connectionString) {
    throw new Error(
      "POSTGRES_DIRECT_URL (or POSTGRES_URL) must be set to run Postgres migrations.",
    );
  }

  const local = isLocalPostgres(connectionString);
  const sql = postgres(connectionString, {
    max: 1,
    connect_timeout: 15,
    ssl: local ? false : "require",
  });

  const start = Date.now();
  try {
    logger.info("Running platform Postgres migrations", {
      folder: info.folder,
      count: info.count,
      local,
    });
    const db = drizzle(sql);
    await migrate(db, { migrationsFolder: info.folder });
    const durationMs = Date.now() - start;
    logger.info("Platform Postgres migrations completed", {
      count: info.count,
      durationMs,
    });
    return { folder: info.folder, count: info.count, durationMs };
  } finally {
    await sql.end({ timeout: 5 });
  }
}

/** Minimal interface implemented by `@electric-sql/pglite`'s `PGlite` class. */
export interface PgliteExecutor {
  exec(query: string): Promise<unknown>;
}

/**
 * Apply all Drizzle SQL migrations in journal order onto an in-process PGlite instance.
 * Intended for fast unit and repository contract tests.
 */
export async function runPgliteMigrations(
  pg: PgliteExecutor,
  customFolder?: string,
): Promise<MigrationsFolderInfo> {
  const info = checkMigrationsFolder(customFolder);
  for (const tag of info.tags) {
    const sqlPath = path.join(info.folder, `${tag}.sql`);
    const sqlText = fs
      .readFileSync(sqlPath, "utf8")
      .replaceAll("--> statement-breakpoint", "");
    await pg.exec(sqlText);
  }
  return info;
}

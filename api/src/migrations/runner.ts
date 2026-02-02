/**
 * Migration Runner
 *
 * Core logic for discovering, tracking, and executing migrations.
 *
 * How it works:
 * 1. Scans the migrations directory for .ts files matching the naming pattern
 * 2. Compares found files against the `migrations` collection in MongoDB
 * 3. Runs pending migrations in lexicographic order (oldest first)
 * 4. Records success/failure with timestamps and duration
 *
 * Migration files must export an `up(db: Db)` function.
 * Optional: export a `description` string for documentation.
 *
 * @see README.md for full documentation and examples
 */

import { Db, Collection } from "mongodb";
import * as fs from "fs";
import * as path from "path";
import {
  MigrationRecord,
  MigrationModule,
  MigrationInfo,
  MigrationStatus,
  MigrationFullStatus,
} from "./types";

/** Collection name for tracking migration status */
const MIGRATIONS_COLLECTION = "migrations";

/** Directory containing migration files (same as this file) */
const MIGRATIONS_DIR = path.join(__dirname);

/**
 * Parse migration ID from filename
 * Expected format: yyyy-mm-dd-hhmmss_name.ts
 */
function parseMigrationFilename(filename: string): MigrationInfo | null {
  // Match pattern: 2024-12-03-143022_some_name.ts
  const match = filename.match(/^(\d{4}-\d{2}-\d{2}-\d{6}_[a-z0-9_]+)\.ts$/i);
  if (!match) {
    return null;
  }

  return {
    id: match[1],
    filename,
    filepath: path.join(MIGRATIONS_DIR, filename),
  };
}

/**
 * Get all migration files from the migrations directory
 */
export function getMigrationFiles(): MigrationInfo[] {
  const files = fs.readdirSync(MIGRATIONS_DIR);

  return files
    .map(parseMigrationFilename)
    .filter((info): info is MigrationInfo => info !== null)
    .sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Get the migrations collection
 */
function getMigrationsCollection(db: Db): Collection<MigrationRecord> {
  return db.collection<MigrationRecord>(MIGRATIONS_COLLECTION);
}

/**
 * Get all migration records from the database
 */
async function getMigrationRecords(
  db: Db,
): Promise<Map<string, MigrationRecord>> {
  const collection = getMigrationsCollection(db);
  const records = await collection.find({}).toArray();

  const map = new Map<string, MigrationRecord>();
  for (const record of records) {
    map.set(record._id, record);
  }

  return map;
}

/**
 * Load a migration module
 */
async function loadMigration(filepath: string): Promise<MigrationModule> {
  const module = await import(filepath);

  if (typeof module.up !== "function") {
    throw new Error(
      `Migration at ${filepath} does not export an 'up' function`,
    );
  }

  return {
    description: module.description,
    up: module.up,
  };
}

/**
 * Get status of all migrations
 */
export async function getMigrationStatus(db: Db): Promise<MigrationStatus[]> {
  const files = getMigrationFiles();
  const records = await getMigrationRecords(db);

  const statuses: MigrationStatus[] = [];

  for (const file of files) {
    const record = records.get(file.id);
    let description: string | undefined;

    try {
      const module = await loadMigration(file.filepath);
      description = module.description;
    } catch {
      // Ignore load errors for status display
    }

    if (!record) {
      statuses.push({
        id: file.id,
        status: "pending",
        ran_at: null,
        description,
      });
    } else if (record.error) {
      statuses.push({
        id: file.id,
        status: "failed",
        ran_at: record.ran_at,
        duration_ms: record.duration_ms,
        error: record.error,
        description,
      });
    } else if (record.ran_at) {
      statuses.push({
        id: file.id,
        status: "completed",
        ran_at: record.ran_at,
        duration_ms: record.duration_ms,
        description,
      });
    } else {
      statuses.push({
        id: file.id,
        status: "pending",
        ran_at: null,
        description,
      });
    }
  }

  return statuses;
}

/**
 * Get full migration status comparing local files vs database records.
 * This shows ALL migrations - both local files and database records,
 * making it easy to spot mismatches (e.g., DB record with no local file).
 */
export async function getMigrationFullStatus(
  db: Db,
): Promise<MigrationFullStatus[]> {
  const files = getMigrationFiles();
  const records = await getMigrationRecords(db);

  const fileIds = new Set(files.map(f => f.id));
  const allIds = new Set([...fileIds, ...records.keys()]);

  const statuses: MigrationFullStatus[] = [];

  for (const id of allIds) {
    const hasLocalFile = fileIds.has(id);
    const record = records.get(id);

    let description: string | undefined;
    if (hasLocalFile) {
      const file = files.find(f => f.id === id);
      if (!file) {
        // This should never happen since hasLocalFile is derived from the same files array.
        // Throw to make any logic bug visible rather than silently omitting the migration.
        throw new Error(
          `Internal error: migration ${id} marked as having local file but not found in files array`,
        );
      }
      try {
        const module = await loadMigration(file.filepath);
        description = module.description;
      } catch {
        // Ignore load errors for status display
      }
    }

    let dbStatus: MigrationFullStatus["dbStatus"];
    if (!record) {
      dbStatus = "missing";
    } else if (record.error) {
      dbStatus = "failed";
    } else if (record.ran_at) {
      dbStatus = "completed";
    } else {
      dbStatus = "pending";
    }

    statuses.push({
      id,
      localFile: hasLocalFile,
      dbStatus,
      ran_at: record?.ran_at ?? null,
      duration_ms: record?.duration_ms,
      error: record?.error,
      description,
    });
  }

  // Sort by ID (chronological order)
  return statuses.sort((a, b) => a.id.localeCompare(b.id));
}

/**
 * Get pending migrations (not yet run)
 */
export async function getPendingMigrations(db: Db): Promise<MigrationInfo[]> {
  const files = getMigrationFiles();
  const records = await getMigrationRecords(db);

  return files.filter(file => {
    const record = records.get(file.id);
    // Pending if no record or ran_at is null
    return !record || record.ran_at === null;
  });
}

/**
 * Run a single migration
 */
async function runMigration(
  db: Db,
  migration: MigrationInfo,
): Promise<{ success: boolean; duration_ms: number; error?: string }> {
  const collection = getMigrationsCollection(db);
  const startTime = Date.now();

  try {
    const module = await loadMigration(migration.filepath);

    // Execute the migration
    await module.up(db);

    const duration_ms = Date.now() - startTime;

    // Record success
    await collection.updateOne(
      { _id: migration.id },
      {
        $set: {
          ran_at: new Date(),
          duration_ms,
        },
        $unset: { error: "" },
      },
      { upsert: true },
    );

    return { success: true, duration_ms };
  } catch (err) {
    const duration_ms = Date.now() - startTime;
    const errorMessage = err instanceof Error ? err.message : String(err);

    // Record failure
    await collection.updateOne(
      { _id: migration.id },
      {
        $set: {
          ran_at: null,
          duration_ms,
          error: errorMessage,
        },
      },
      { upsert: true },
    );

    return { success: false, duration_ms, error: errorMessage };
  }
}

export interface RunMigrationsResult {
  completed: number;
  failed: number;
  results: Array<{
    id: string;
    success: boolean;
    duration_ms: number;
    error?: string;
  }>;
}

/**
 * Run all pending migrations
 */
export async function runPendingMigrations(
  db: Db,
  options?: { stopOnError?: boolean },
): Promise<RunMigrationsResult> {
  const stopOnError = options?.stopOnError ?? true;
  const pending = await getPendingMigrations(db);

  const result: RunMigrationsResult = {
    completed: 0,
    failed: 0,
    results: [],
  };

  for (const migration of pending) {
    const migrationResult = await runMigration(db, migration);

    result.results.push({
      id: migration.id,
      ...migrationResult,
    });

    if (migrationResult.success) {
      result.completed++;
    } else {
      result.failed++;
      if (stopOnError) {
        break;
      }
    }
  }

  return result;
}

/**
 * Generate a migration ID with current timestamp
 */
export function generateMigrationId(name: string): string {
  const now = new Date();
  const datePart = [
    now.getFullYear(),
    String(now.getMonth() + 1).padStart(2, "0"),
    String(now.getDate()).padStart(2, "0"),
  ].join("-");
  const timePart = [
    String(now.getHours()).padStart(2, "0"),
    String(now.getMinutes()).padStart(2, "0"),
    String(now.getSeconds()).padStart(2, "0"),
  ].join("");
  const timestamp = `${datePart}-${timePart}`;

  // Sanitize name: lowercase, replace spaces/dashes with underscores
  const sanitizedName = name
    .toLowerCase()
    .replace(/[\s-]+/g, "_")
    .replace(/[^a-z0-9_]/g, "");

  return `${timestamp}_${sanitizedName}`;
}

/**
 * Generate migration file content
 */
export function generateMigrationContent(description: string): string {
  return `import { Db } from "mongodb";

export const description = "${description}";

export async function up(db: Db): Promise<void> {
  // TODO: Implement migration
  // Example:
  // await db.collection("users").createIndex({ email: 1 });
}
`;
}

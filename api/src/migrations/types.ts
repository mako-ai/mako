/**
 * Migration System Types
 *
 * This file defines the TypeScript interfaces used throughout the migration system.
 *
 * @see README.md for full documentation
 * @see runner.ts for implementation
 * @see cli.ts for command-line interface
 */

import { Db } from "mongodb";

/**
 * Migration record stored in the `migrations` collection.
 * Tracks which migrations have run and their execution status.
 */
export interface MigrationRecord {
  _id: string; // Migration ID (e.g., "2024-12-03-143022_add_indexes")
  ran_at: Date | null; // null = not yet run
  duration_ms?: number; // Execution time in milliseconds
  error?: string; // Error message if migration failed
}

/**
 * Migration module interface - what each migration file should export
 */
export interface MigrationModule {
  description?: string;
  up: (db: Db) => Promise<void>;
}

/**
 * Parsed migration info from file system
 */
export interface MigrationInfo {
  id: string;
  filename: string;
  filepath: string;
}

/**
 * Migration status for display
 */
export interface MigrationStatus {
  id: string;
  status: "pending" | "completed" | "failed";
  ran_at: Date | null;
  duration_ms?: number;
  error?: string;
  description?: string;
}

/**
 * Full migration status comparing local files vs database records
 */
export interface MigrationFullStatus {
  id: string;
  localFile: boolean; // true if file exists locally
  dbStatus: "pending" | "completed" | "failed" | "missing"; // "missing" = not in DB
  ran_at: Date | null;
  duration_ms?: number;
  error?: string;
  description?: string;
}


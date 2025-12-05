/**
 * Migration CLI
 *
 * Command-line interface for managing MongoDB migrations.
 *
 * Usage:
 *   pnpm run migrate              # Run all pending migrations (default)
 *   pnpm run migrate status       # Show status of all migrations
 *   pnpm run migrate create "name" # Create a new migration file
 *
 * @see README.md for full documentation and examples
 */

/* eslint-disable no-process-exit */
import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import { databaseConnectionService } from "../services/database-connection.service";
import {
  getMigrationFullStatus,
  runPendingMigrations,
  generateMigrationId,
  generateMigrationContent,
  getPendingMigrations,
} from "./runner";

const MIGRATIONS_DIR = path.join(__dirname);

/**
 * Format a date for display
 */
function formatDate(date: Date | null): string {
  if (!date) return "-";
  return date.toISOString().replace("T", " ").substring(0, 19);
}

/**
 * Pad string to specified length
 */
function pad(str: string, length: number): string {
  return str.padEnd(length);
}

/**
 * Print a table row
 */
function printRow(cols: string[], widths: number[]): void {
  const cells = cols.map((col, i) => pad(col, widths[i]));
  console.log(`│ ${cells.join(" │ ")} │`);
}

/**
 * Print table separator
 */
function printSeparator(widths: number[], char: "┬" | "┼" | "┴"): void {
  const topChar = char === "┬" ? "┌" : char === "┴" ? "└" : "├";
  const bottomChar = char === "┬" ? "┐" : char === "┴" ? "┘" : "┤";
  const lines = widths.map(w => "─".repeat(w + 2));
  console.log(`${topChar}${lines.join(char)}${bottomChar}`);
}

/**
 * Status command - show migration status
 */
async function statusCommand(): Promise<void> {
  try {
    const { db } = await databaseConnectionService.getMainConnection();
    const statuses = await getMigrationFullStatus(db);

    console.log("\nMigration Status:\n");

    if (statuses.length === 0) {
      console.log("No migrations found (no local files, no database records).");
      console.log('Create one with: pnpm run migrate create "migration name"');
      await databaseConnectionService.closeAllConnections();
      process.exit(0);
    }

    // Calculate column widths
    const idWidth = Math.max(4, ...statuses.map(s => s.id.length));
    const localWidth = 7; // "Local"
    const serverWidth = 10; // "Server"
    const ranAtWidth = 19;
    const widths = [idWidth, localWidth, serverWidth, ranAtWidth];

    // Print header
    printSeparator(widths, "┬");
    printRow(["ID", "Local", "Server", "Ran At"], widths);
    printSeparator(widths, "┼");

    // Print rows
    for (const status of statuses) {
      const localStr = status.localFile ? "✓" : "✗";
      const serverStr =
        status.dbStatus === "completed"
          ? "completed"
          : status.dbStatus === "failed"
            ? "failed"
            : status.dbStatus === "pending"
              ? "pending"
              : "-";
      printRow([status.id, localStr, serverStr, formatDate(status.ran_at)], widths);
    }

    printSeparator(widths, "┴");

    // Summary
    const completed = statuses.filter(s => s.dbStatus === "completed").length;
    const pending = statuses.filter(
      s => s.localFile && s.dbStatus === "missing",
    ).length;
    const failed = statuses.filter(s => s.dbStatus === "failed").length;
    const orphaned = statuses.filter(
      s => !s.localFile && s.dbStatus !== "missing",
    ).length;

    const parts = [`${completed} completed`, `${pending} pending`];
    if (failed > 0) parts.push(`${failed} failed`);
    if (orphaned > 0) parts.push(`${orphaned} orphaned (no local file)`);

    console.log(`\n${parts.join(", ")}`);

    await databaseConnectionService.closeAllConnections();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    await databaseConnectionService.closeAllConnections();
    process.exit(1);
  }
}

/**
 * Run command - execute pending migrations
 */
async function runCommand(): Promise<void> {
  try {
    const { db } = await databaseConnectionService.getMainConnection();
    const pending = await getPendingMigrations(db);

    if (pending.length === 0) {
      console.log("\n✓ No pending migrations.");
      await databaseConnectionService.closeAllConnections();
      process.exit(0);
    }

    console.log(`\nRunning ${pending.length} migration(s)...\n`);

    const result = await runPendingMigrations(db);

    for (const r of result.results) {
      if (r.success) {
        console.log(`  ✓ ${r.id} (${r.duration_ms}ms)`);
      } else {
        console.log(`  ✗ ${r.id} (${r.duration_ms}ms)`);
        console.log(`    Error: ${r.error}`);
      }
    }

    console.log();

    if (result.failed > 0) {
      console.log(
        `❌ ${result.completed} completed, ${result.failed} failed.`,
      );
      await databaseConnectionService.closeAllConnections();
      process.exit(1);
    }

    console.log(`✓ ${result.completed} migration(s) completed.`);
    await databaseConnectionService.closeAllConnections();
    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    await databaseConnectionService.closeAllConnections();
    process.exit(1);
  }
}

/**
 * Create command - scaffold a new migration file
 */
async function createCommand(name: string): Promise<void> {
  try {
    if (!name || name.trim().length === 0) {
      console.error("❌ Migration name is required");
      process.exit(1);
    }

    const migrationId = generateMigrationId(name);
    const filename = `${migrationId}.ts`;
    const filepath = path.join(MIGRATIONS_DIR, filename);

    // Check if file already exists
    if (fs.existsSync(filepath)) {
      console.error(`❌ Migration file already exists: ${filename}`);
      process.exit(1);
    }

    // Generate and write content
    const content = generateMigrationContent(name);
    fs.writeFileSync(filepath, content, "utf-8");

    console.log(`\n✓ Created migration: ${filename}`);
    console.log(`  Path: ${filepath}`);
    process.exit(0);
  } catch (error) {
    console.error("❌ Error:", error);
    process.exit(1);
  }
}

// Create commander program
const program = new Command();

program
  .name("migrate")
  .description("MongoDB migration tool")
  .version("1.0.0");

program
  .command("status")
  .description("Show status of all migrations")
  .action(statusCommand);

program
  .command("create <name>")
  .description("Create a new migration file")
  .action(createCommand);

program
  .command("run", { isDefault: true })
  .description("Run all pending migrations (default command)")
  .action(runCommand);

// Parse arguments
program.parse(process.argv);


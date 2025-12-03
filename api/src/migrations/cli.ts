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
  getMigrationStatus,
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
    const statuses = await getMigrationStatus(db);

    if (statuses.length === 0) {
      console.log("\nNo migrations found.");
      console.log('Create one with: pnpm run migrate create "migration name"');
      await databaseConnectionService.closeAllConnections();
      process.exit(0);
    }

    console.log("\nMigration Status:\n");

    // Calculate column widths
    const idWidth = Math.max(4, ...statuses.map(s => s.id.length));
    const statusWidth = 10;
    const ranAtWidth = 19;
    const widths = [idWidth, statusWidth, ranAtWidth];

    // Print header
    printSeparator(widths, "┬");
    printRow(["ID", "Status", "Ran At"], widths);
    printSeparator(widths, "┼");

    // Print rows
    for (const status of statuses) {
      const statusStr =
        status.status === "completed"
          ? "completed"
          : status.status === "failed"
            ? "failed"
            : "pending";
      printRow([status.id, statusStr, formatDate(status.ran_at)], widths);
    }

    printSeparator(widths, "┴");

    // Summary
    const completed = statuses.filter(s => s.status === "completed").length;
    const pending = statuses.filter(s => s.status === "pending").length;
    const failed = statuses.filter(s => s.status === "failed").length;

    console.log(
      `\n${completed} completed, ${pending} pending${failed > 0 ? `, ${failed} failed` : ""}`,
    );

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


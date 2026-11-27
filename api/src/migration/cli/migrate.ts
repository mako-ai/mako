/**
 * CLI: run pending Drizzle SQL migrations against the platform Postgres database.
 *
 * Usage:
 *   pnpm --filter api run pg:migrate
 *   pnpm --filter api run pg:migrate -- --check
 */
import { Command } from "commander";
import {
  checkMigrationsFolder,
  runPgMigrations,
} from "../../database/pg/migrate";
import { loadMigrationCliEnv } from "./env";

loadMigrationCliEnv();

const program = new Command()
  .name("pg:migrate")
  .description("Apply platform Postgres (Neon) Drizzle SQL migrations")
  .option("--check", "Validate migrations folder & journal without connecting")
  .option("--folder <path>", "Custom migrations folder path");

async function main(): Promise<void> {
  const argv =
    process.argv[2] === "--"
      ? [process.argv[0], process.argv[1], ...process.argv.slice(3)]
      : process.argv;
  program.parse(argv);
  const opts = program.opts<{ check?: boolean; folder?: string }>();

  const info = checkMigrationsFolder(opts.folder);
  console.info(
    `[pg:migrate] Verified ${info.count} migration(s) in ${info.folder}: ${info.tags.join(", ")}`,
  );

  if (opts.check) {
    return;
  }

  const res = await runPgMigrations({ migrationsFolder: opts.folder });
  console.info(
    `[pg:migrate] Applied ${res.count} migration(s) in ${res.durationMs}ms`,
  );
}

main().catch(error => {
  console.error(
    "[pg:migrate] Failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});

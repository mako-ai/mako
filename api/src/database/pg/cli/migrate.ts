/**
 * CLI: run pending Drizzle SQL migrations against the platform Postgres database.
 *
 * Usage:
 *   pnpm --filter api run pg:migrate
 *   pnpm --filter api run pg:migrate -- --check
 *   pnpm --filter api run pg:migrate -- --post-backfill sessions-active-workspace-fk
 */
import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import dotenv from "dotenv";
import { closePgConnections, getPgDirectDb } from "../client";
import { checkMigrationsFolder, runPgMigrations } from "../migrate";
import {
  POST_BACKFILL_STEPS,
  getPostBackfillStep,
  readPostBackfillStatements,
  runPostBackfillStep,
} from "../post-backfill";

function loadCliEnv(): void {
  const candidates = [
    path.resolve(__dirname, "../../../../../.env"), // repo root
    path.resolve(__dirname, "../../../../.env"), // api/.env fallback
  ];
  for (const envPath of candidates) {
    if (fs.existsSync(envPath)) {
      dotenv.config({ path: envPath, quiet: true });
    }
  }
}

loadCliEnv();

const program = new Command()
  .name("pg:migrate")
  .description("Apply platform Postgres (Neon) Drizzle SQL migrations")
  .option("--check", "Validate migrations folder & journal without connecting")
  .option("--folder <path>", "Custom migrations folder path")
  .option(
    "--post-backfill <step>",
    `Run one post-backfill DDL step instead of the journal (${POST_BACKFILL_STEPS.map(s => s.name).join(", ")})`,
  )
  .option(
    "--force",
    "Bypass post-backfill precondition checks (dangerous; operator override only)",
  );

async function main(): Promise<void> {
  const argv =
    process.argv[2] === "--"
      ? [process.argv[0], process.argv[1], ...process.argv.slice(3)]
      : process.argv;
  program.parse(argv);
  const opts = program.opts<{
    check?: boolean;
    folder?: string;
    postBackfill?: string;
    force?: boolean;
  }>();

  if (opts.postBackfill) {
    const step = getPostBackfillStep(opts.postBackfill);
    const statements = readPostBackfillStatements(step.name);
    console.info(
      `[pg:migrate] Post-backfill step "${step.name}" (${statements.length} statement(s)); requires: ${step.requires}`,
    );
    if (opts.check) return;
    try {
      await runPostBackfillStep(getPgDirectDb(), step.name, {
        force: Boolean(opts.force),
      });
      console.info(`[pg:migrate] Post-backfill step "${step.name}" applied`);
    } finally {
      await closePgConnections();
    }
    return;
  }

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

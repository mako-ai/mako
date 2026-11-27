/**
 * CLI: run offline chunked MongoDB vs Postgres parity verification (+ optional --repair).
 *
 * Usage:
 *   pnpm --filter api run pg:verify -- --list
 *   pnpm --filter api run pg:verify -- --domain auth --batch 1000
 *   pnpm --filter api run pg:verify -- --domain chat --workspace <oid-or-uuid> --repair
 */
import { Command } from "commander";
import mongoose from "mongoose";
import { closePgConnections } from "../../database/pg/client";
import { registerMigrationDomains } from "../domains";
import { listVerifierDomains, runParityVerification } from "../verifier";
import { loadMigrationCliEnv } from "./env";

loadMigrationCliEnv();

registerMigrationDomains();

const program = new Command()
  .name("pg:verify")
  .description("Chunked MongoDB vs Postgres parity verifier")
  .option("--list", "List registered parity verifier domains")
  .option("-d, --domain <domain>", "Domain to verify")
  .option(
    "-w, --workspace <id>",
    "Optional workspace ID (24-hex ObjectId or UUID)",
  )
  .option("-b, --batch <size>", "Batch size (default 1000)", "1000")
  .option(
    "--repair",
    "Idempotently repair missing or mismatched rows in Postgres",
    false,
  );

async function main(): Promise<void> {
  const argv =
    process.argv[2] === "--"
      ? [process.argv[0], process.argv[1], ...process.argv.slice(3)]
      : process.argv;
  program.parse(argv);
  const opts = program.opts<{
    list?: boolean;
    domain?: string;
    workspace?: string;
    batch: string;
    repair: boolean;
  }>();

  if (opts.list) {
    const domains = listVerifierDomains();
    console.info(
      domains.length > 0
        ? `Registered verifier domains: ${domains.join(", ")}`
        : "No verifier domains registered yet (Phase 0 foundation).",
    );
    return;
  }

  if (!opts.domain) {
    console.error("Error: --domain <domain> is required (or pass --list).");
    process.exitCode = 1;
    return;
  }

  const batchSize = Number.parseInt(opts.batch, 10);
  if (!Number.isFinite(batchSize) || batchSize <= 0) {
    console.error(`Invalid --batch value: ${opts.batch}`);
    process.exitCode = 1;
    return;
  }

  const mongoUri = process.env.DATABASE_URL?.trim();
  if (!mongoUri) {
    console.error("Error: DATABASE_URL must be set to run pg:verify.");
    process.exitCode = 1;
    return;
  }

  try {
    await mongoose.connect(mongoUri);
    const report = await runParityVerification({
      domain: opts.domain,
      workspaceId: opts.workspace ?? null,
      batchSize,
      repair: opts.repair,
    });
    console.info(JSON.stringify(report, null, 2));
    if (!report.ok) {
      process.exitCode = 1;
    }
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await closePgConnections();
  }
}

main().catch(error => {
  console.error(
    "[pg:verify] Failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});

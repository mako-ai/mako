/**
 * CLI: run or resume a MongoDB -> Postgres backfill for a registered migration domain.
 *
 * Usage:
 *   pnpm --filter api run pg:backfill -- --list
 *   pnpm --filter api run pg:backfill -- --domain auth --batch 1000
 *   pnpm --filter api run pg:backfill -- --domain chat --workspace <oid-or-uuid> --dry-run
 */
import { Command } from "commander";
import { closePgConnections } from "../../database/pg/client";
import { listBackfillDomains, runBackfill } from "../backfill";

const program = new Command()
  .name("pg:backfill")
  .description("Resumable MongoDB -> Postgres backfill runner")
  .option("--list", "List registered backfill domains")
  .option("-d, --domain <domain>", "Domain to backfill")
  .option(
    "-w, --workspace <id>",
    "Optional workspace ID (24-hex ObjectId or UUID)",
  )
  .option("-b, --batch <size>", "Batch size (default 1000)", "1000")
  .option("--max-batches <n>", "Stop after N batches (status = paused)")
  .option("--dry-run", "Scan and validate without writing to Postgres", false)
  .option(
    "--reset-cursor",
    "Ignore saved checkpoint and start from scratch",
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
    maxBatches?: string;
    dryRun: boolean;
    resetCursor: boolean;
  }>();

  if (opts.list) {
    const domains = listBackfillDomains();
    console.info(
      domains.length > 0
        ? `Registered backfill domains: ${domains.join(", ")}`
        : "No backfill domains registered yet (Phase 0 foundation).",
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

  const maxBatches = opts.maxBatches
    ? Number.parseInt(opts.maxBatches, 10)
    : undefined;
  if (
    maxBatches !== undefined &&
    (!Number.isFinite(maxBatches) || maxBatches <= 0)
  ) {
    console.error(`Invalid --max-batches value: ${opts.maxBatches}`);
    process.exitCode = 1;
    return;
  }

  try {
    const summary = await runBackfill({
      domain: opts.domain,
      workspaceId: opts.workspace ?? null,
      batchSize,
      maxBatches,
      dryRun: opts.dryRun,
      resetCursor: opts.resetCursor,
    });
    console.info(JSON.stringify(summary, null, 2));
  } finally {
    await closePgConnections();
  }
}

main().catch(error => {
  console.error(
    "[pg:backfill] Failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});

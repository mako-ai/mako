/**
 * CLI: inspect or update `migration_domain_state` rollout modes (global or per-workspace)
 * and optionally broadcast Redis cache invalidation to running API instances.
 *
 * Usage:
 *   pnpm --filter api run pg:mode -- --status
 *   pnpm --filter api run pg:mode -- --domain workspaces_core --mode dual_write_mongo_read
 *   pnpm --filter api run pg:mode -- --domain workspaces_core --mode dual_write_shadow_compare --sample-rate 1 --workspace 6846e6a01b05af0948070582
 */
import { Command } from "commander";
import { asc } from "drizzle-orm";
import {
  closePgConnections,
  getPgDirectDb,
  hasDirectPostgresConfig,
} from "../../database/pg/client";
import {
  MIGRATION_MODES,
  migrationDomainState,
  type MigrationMode,
} from "../../database/pg/schema";
import { MigrationRouter } from "../router";
import { loadMigrationCliEnv } from "./env";

loadMigrationCliEnv();

const VALID_MODES = new Set<string>(MIGRATION_MODES);

const program = new Command()
  .name("pg:mode")
  .description("Inspect or update Postgres migration domain rollout stages")
  .option("--status", "Print all rows in migration_domain_state", false)
  .option("-d, --domain <domain>", "Domain name (e.g. auth, workspaces_core)")
  .option("-m, --mode <mode>", `Target stage (${MIGRATION_MODES.join(", ")})`)
  .option(
    "-w, --workspace <id>",
    "Optional workspace ID (24-hex ObjectId or UUID) for canary override",
  )
  .option(
    "-r, --sample-rate <rate>",
    "Optional shadow_sample_rate in [0, 1] (must be > 0 for dual_write_shadow_compare)",
  )
  .option("--updated-by <actor>", "Audit actor label", "cli:pg:mode");

async function main(): Promise<void> {
  const argv =
    process.argv[2] === "--"
      ? [process.argv[0], process.argv[1], ...process.argv.slice(3)]
      : process.argv;
  program.parse(argv);
  const opts = program.opts<{
    status: boolean;
    domain?: string;
    mode?: string;
    workspace?: string;
    sampleRate?: string;
    updatedBy: string;
  }>();

  if (!hasDirectPostgresConfig()) {
    console.error(
      "Error: POSTGRES_DIRECT_URL or POSTGRES_URL must be set to run pg:mode.",
    );
    process.exitCode = 1;
    return;
  }

  const enablePubSub = Boolean(process.env.REDIS_URL?.trim());
  const router = new MigrationRouter({
    enablePubSub,
    autoSubscribe: false,
    getDb: getPgDirectDb,
    hasPg: hasDirectPostgresConfig,
  });

  try {
    if (opts.status || (!opts.domain && !opts.mode)) {
      const db = getPgDirectDb();
      const rows = await db
        .select()
        .from(migrationDomainState)
        .orderBy(
          asc(migrationDomainState.domain),
          asc(migrationDomainState.scopeKey),
        );
      console.info(JSON.stringify({ count: rows.length, rows }, null, 2));
      return;
    }

    if (!opts.domain || !opts.mode) {
      console.error("Error: both --domain and --mode are required.");
      process.exitCode = 1;
      return;
    }

    if (!VALID_MODES.has(opts.mode)) {
      console.error(
        `Invalid --mode "${opts.mode}". Expected one of: ${MIGRATION_MODES.join(", ")}`,
      );
      process.exitCode = 1;
      return;
    }

    let shadowSampleRate: number | undefined;
    if (opts.sampleRate !== undefined) {
      shadowSampleRate = Number.parseFloat(opts.sampleRate);
      if (
        !Number.isFinite(shadowSampleRate) ||
        shadowSampleRate < 0 ||
        shadowSampleRate > 1
      ) {
        console.error(`Invalid --sample-rate "${opts.sampleRate}"`);
        process.exitCode = 1;
        return;
      }
    }

    const updated = await router.setDomainState({
      domain: opts.domain,
      mode: opts.mode as MigrationMode,
      workspaceId: opts.workspace ?? null,
      shadowSampleRate,
      updatedBy: opts.updatedBy,
    });
    console.info(
      JSON.stringify(
        { updated, redisInvalidationBroadcast: enablePubSub },
        null,
        2,
      ),
    );
  } finally {
    await router.stopInvalidationListener();
    await closePgConnections();
  }
}

main().catch(error => {
  console.error(
    "[pg:mode] Failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});

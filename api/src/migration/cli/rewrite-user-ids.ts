/**
 * CLI: rewrite legacy text user IDs (`15-char Lucia` / legacy `UUIDv4`) to canonical
 * Postgres UUIDv7 IDs across MongoDB collections and/or workspace git directories.
 *
 * Reads the `legacy_id -> uuid` map from Postgres `users`.
 * Defaults to `--dry-run` so invoking without explicit apply flags never mutates data.
 *
 * Usage:
 *   pnpm --filter api run pg:rewrite-user-ids -- --dry-run
 *   pnpm --filter api run pg:rewrite-user-ids -- --apply-mongo
 *   pnpm --filter api run pg:rewrite-user-ids -- --apply-git /path/to/workspace-repo
 *   pnpm --filter api run pg:rewrite-user-ids -- --apply-mongo --dry-run
 */
import { Command } from "commander";
import mongoose from "mongoose";
import {
  closePgConnections,
  getPgDirectDb,
  hasDirectPostgresConfig,
} from "../../database/pg/client";
import { MigrationRouter } from "../router";
import {
  ALLOWED_APPLY_AUTH_MODES,
  assertAuthStageAllowsRewriteApply,
  loadUserLegacyIdMap,
  MONGO_USER_ID_REWRITE_SPECS,
  rewriteGitUserIds,
  rewriteMongoUserIds,
  validateRewriteCollections,
} from "../rewrite-user-ids";
import { loadMigrationCliEnv } from "./env";

loadMigrationCliEnv();

const program = new Command()
  .name("pg:rewrite-user-ids")
  .description(
    "Rewrite legacy user IDs (users.legacy_id -> users.id UUIDv7) across MongoDB and workspace git repos",
  )
  .option("--list", "List all MongoDB collections covered by the rewriter")
  .option(
    "--dry-run",
    "Scan and report matches without modifying MongoDB or git files (default when no --apply-* flag is set)",
  )
  .option(
    "--mongo",
    "Scan MongoDB collections in dry-run mode (use --apply-mongo to apply)",
    false,
  )
  .option(
    "--apply-mongo",
    "Apply legacy user-ID rewrites to MongoDB collections (requires auth stage 4/5 unless --force)",
    false,
  )
  .option(
    "--git <repoDir>",
    "Scan a workspace git working directory in dry-run mode",
  )
  .option(
    "--apply-git <repoDir>",
    "Apply legacy user-ID rewrites inside a workspace git working directory (requires auth stage 4/5 unless --force)",
  )
  .option(
    "--collections <names>",
    "Comma-separated subset of MongoDB collection names to process",
  )
  .option(
    "--force",
    "Override the Stage 4/5 auth rollout safety gate when applying rewrites",
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
    dryRun?: boolean;
    mongo: boolean;
    applyMongo: boolean;
    git?: string;
    applyGit?: string;
    collections?: string;
    force: boolean;
  }>();

  if (opts.list) {
    console.info(
      `Covered MongoDB collections (${MONGO_USER_ID_REWRITE_SPECS.length}): ` +
        MONGO_USER_ID_REWRITE_SPECS.map(s => s.collection).join(", "),
    );
    return;
  }

  const runMongo = opts.mongo || opts.applyMongo;
  const gitDir = opts.applyGit ?? opts.git;
  const forceDryRun = Boolean(opts.dryRun);
  const applyingMongo = Boolean(opts.applyMongo) && !forceDryRun;
  const applyingGit = Boolean(opts.applyGit) && !forceDryRun;

  let collections: string[] | undefined;
  if (opts.collections !== undefined) {
    collections = opts.collections
      .split(",")
      .map(s => s.trim())
      .filter(Boolean);
    if (collections.length === 0) {
      throw new Error(
        "--collections must specify at least one collection name.",
      );
    }
    validateRewriteCollections(collections);
  }

  try {
    const summary: Record<string, unknown> = {
      mode: applyingMongo || applyingGit ? "apply" : "dry-run",
    };

    if (applyingMongo || applyingGit) {
      const cliRouter = new MigrationRouter({
        enablePubSub: false,
        getDb: getPgDirectDb,
        hasPg: hasDirectPostgresConfig,
      });
      const authState = await assertAuthStageAllowsRewriteApply({
        router: cliRouter,
        force: opts.force,
      });
      summary.authStage = authState.mode;
      if (opts.force && !ALLOWED_APPLY_AUTH_MODES.has(authState.mode)) {
        summary.forceOverride = true;
      }
    }

    const userIdMap = await loadUserLegacyIdMap();
    summary.mappedLegacyUsers = userIdMap.size;

    if (!runMongo && !gitDir) {
      // Safe default: print map count and instructions without mutating anything.
      summary.note =
        "Dry-run summary only. Pass --mongo / --apply-mongo and/or --git <dir> / --apply-git <dir>.";
      console.info(JSON.stringify(summary, null, 2));
      return;
    }

    if (runMongo) {
      const mongoUri = process.env.DATABASE_URL?.trim();
      if (!mongoUri) {
        throw new Error(
          "DATABASE_URL must be set when running with --mongo or --apply-mongo.",
        );
      }
      await mongoose.connect(mongoUri);
      const mongoDb = mongoose.connection.db;
      if (!mongoDb) {
        throw new Error("MongoDB connection did not expose a Db handle.");
      }
      summary.mongo = await rewriteMongoUserIds({
        mongoDb,
        userIdMap,
        dryRun: !applyingMongo,
        collections,
      });
    }

    if (gitDir) {
      summary.git = await rewriteGitUserIds({
        repoDir: gitDir,
        userIdMap,
        dryRun: !applyingGit,
      });
    }

    console.info(JSON.stringify(summary, null, 2));
  } finally {
    if (mongoose.connection.readyState !== 0) {
      await mongoose.disconnect();
    }
    await closePgConnections();
  }
}

main().catch(error => {
  console.error(
    "[pg:rewrite-user-ids] Failed:",
    error instanceof Error ? error.message : String(error),
  );
  process.exitCode = 1;
});

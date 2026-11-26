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
import { closePgConnections } from "../../database/pg/client";
import {
  loadUserLegacyIdMap,
  MONGO_USER_ID_REWRITE_SPECS,
  rewriteGitUserIds,
  rewriteMongoUserIds,
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
    "Apply legacy user-ID rewrites to MongoDB collections",
    false,
  )
  .option(
    "--git <repoDir>",
    "Scan a workspace git working directory in dry-run mode",
  )
  .option(
    "--apply-git <repoDir>",
    "Apply legacy user-ID rewrites inside a workspace git working directory",
  )
  .option(
    "--collections <names>",
    "Comma-separated subset of MongoDB collection names to process",
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

  try {
    const userIdMap = await loadUserLegacyIdMap();
    const summary: Record<string, unknown> = {
      mappedLegacyUsers: userIdMap.size,
      mode: forceDryRun
        ? "dry-run"
        : opts.applyMongo || opts.applyGit
          ? "apply"
          : "dry-run",
    };

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
      const collections = opts.collections
        ? opts.collections
            .split(",")
            .map(s => s.trim())
            .filter(Boolean)
        : undefined;
      summary.mongo = await rewriteMongoUserIds({
        mongoDb,
        userIdMap,
        dryRun: forceDryRun || !opts.applyMongo,
        collections,
      });
    }

    if (gitDir) {
      summary.git = await rewriteGitUserIds({
        repoDir: gitDir,
        userIdMap,
        dryRun: forceDryRun || !opts.applyGit,
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

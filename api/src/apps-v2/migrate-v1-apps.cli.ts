/**
 * Operator CLI for the v1→v2 app migration.
 *
 *   pnpm apps:migrate-v1 --workspace <id>              # DRY RUN: print the plan
 *   pnpm apps:migrate-v1 --workspace <id> --execute    # do it
 *   pnpm apps:migrate-v1 --workspace <id> --app <id> --execute
 *
 * Dry run is the default on purpose: the command's first job is to show what
 * would move and what cannot (non-SQL bindings, live materialization), and an
 * operator should read that before anything writes. NOT a DB migration —
 * those run automatically on deploy, and moving customer apps between
 * architectures is a decision someone makes per workspace, not a side effect
 * of shipping.
 */
// The root .env, wherever this is run from — tsx's cwd is api/, the env
// file is the repo's.
import path from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(process.cwd(), ".env") });
loadEnv({ path: path.resolve(process.cwd(), "..", ".env") });
import mongoose from "mongoose";
import { migrateWorkspaceV1Apps } from "./migrate-v1-apps";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const workspaceId = arg("workspace");
  const appId = arg("app");
  const execute = process.argv.includes("--execute");
  if (!workspaceId) {
    throw new Error(
      "Usage: migrate-v1-apps --workspace <id> [--app <id>] [--execute]",
    );
  }

  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error("DATABASE_URL is not set");
  await mongoose.connect(uri);

  const results = await migrateWorkspaceV1Apps({ workspaceId, appId, execute });
  for (const r of results) {
    const marker = r.alreadyMigrated
      ? "SKIP (already migrated)"
      : execute
        ? `MIGRATED -> apps/${r.slug}`
        : "WOULD MIGRATE";
    console.log(`${marker}  ${r.title}  (${r.v1AppId})`);
    console.log(
      `  files: ${r.fileCount}  bindings: ${r.bindings.migrated.length} migrated` +
        (r.bindings.skipped.length
          ? `, ${r.bindings.skipped.length} NEED ATTENTION`
          : "") +
        `  access: ${r.access}`,
    );
    if (r.bindings.carried.length) {
      console.log(
        `  data carried over (artifact + last run): ${r.bindings.carried.join(", ")}`,
      );
    }
    for (const live of r.bindings.liveAsScheduled) {
      console.log(
        `  ~ binding "${live.name}" was live; now refreshes on "${live.cron}"`,
      );
    }
    for (const skipped of r.bindings.skipped) {
      console.log(`  ! binding "${skipped.name}": ${skipped.reason}`);
    }
  }
  if (!execute) {
    console.log(`\nDry run — nothing written. Re-run with --execute to apply.`);
  }
  await mongoose.disconnect();
}

main()
  .then(() => {
    // Exit explicitly: the services this pulls in (mirror queue, pub/sub,
    // loggers) keep handles open, and an operator CLI that hangs after
    // printing "Dry run — nothing written" looks like it did not finish.
    // eslint-disable-next-line no-process-exit -- operator CLI, not server code
    process.exit(0);
  })
  .catch(error => {
    console.error(error instanceof Error ? error.message : error);
    // eslint-disable-next-line no-process-exit -- operator CLI, not server code
    process.exit(1);
  });

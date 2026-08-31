/* eslint-disable no-console */
/**
 * Operator CLI for adopting consoles into a workspace repo (apps.md §16.5).
 *
 *   pnpm consoles:migrate --workspace <id>                 # DRY RUN
 *   pnpm consoles:migrate --workspace <id> --execute       # replay + adopt
 *   pnpm consoles:migrate --all --execute                  # every workspace with a repo
 *   pnpm consoles:migrate --reconcile-descriptions [--workspace <id>]
 *
 * Only workspaces with a repo (a local bare repo, or a connected GitHub repo
 * where the connected tier is enabled) are adopted — there is no Mako-hosted
 * tier (apps.md §17). `--reconcile-descriptions` queues description/embedding
 * derivation for rows behind their content or on a stale embedding model.
 */
import path from "node:path";
import { config as loadEnv } from "dotenv";
loadEnv({ path: path.resolve(process.cwd(), ".env") });
loadEnv({ path: path.resolve(process.cwd(), "..", ".env") });
import mongoose from "mongoose";
import {
  adoptWorkspaceConsoles,
  reconcileConsoleDescriptions,
} from "./workspace-consoles.service";
import { resolveMirrorTarget } from "./cloud-repo.service";
import { repoDirFor, repoExists } from "./repository.service";
import { SavedConsole } from "../database/workspace-schema";

function arg(name: string): string | undefined {
  const at = process.argv.indexOf(`--${name}`);
  return at === -1 ? undefined : process.argv[at + 1];
}

async function main(): Promise<void> {
  const workspaceId = arg("workspace");
  const all = process.argv.includes("--all");
  const execute = process.argv.includes("--execute");
  const reconcile = process.argv.includes("--reconcile-descriptions");
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error("DATABASE_URL is not set");
  await mongoose.connect(uri);
  try {
    if (reconcile) {
      const n = await reconcileConsoleDescriptions(workspaceId);
      console.log(`queued description derivation for ${n} console(s)`);
      return;
    }
    let ids: string[];
    if (workspaceId) ids = [workspaceId];
    else if (all) {
      ids = (
        (await SavedConsole.distinct("workspaceId", {
          isSaved: true,
          $or: [
            { is_deleted: { $ne: true } },
            { is_deleted: { $exists: false } },
          ],
        })) as Array<{ toString(): string }>
      ).map(w => w.toString());
    } else {
      throw new Error(
        "Usage: migrate-consoles (--workspace <id> | --all) [--execute]",
      );
    }
    for (const id of ids) {
      const hasLocal = await repoExists(repoDirFor(id));
      const mirror = await resolveMirrorTarget(id).catch(() => null);
      if (!hasLocal && !mirror) {
        console.log(`${id}: no repo (connect GitHub first) — skipped`);
        continue;
      }
      const report = await adoptWorkspaceConsoles(id, {
        replayHistory: true,
        dryRun: !execute,
      });
      console.log(JSON.stringify(report));
    }
    if (!execute) console.log("dry run — pass --execute to write");
  } finally {
    await mongoose.disconnect();
  }
}

main().then(
  () => {
    // Module-level clients (Inngest, realtime) keep handles open; an
    // operator CLI ends when its work does.
    // eslint-disable-next-line no-process-exit -- operator CLI, not server code
    process.exit(0);
  },
  error => {
    console.error(error instanceof Error ? error.message : error);
    // eslint-disable-next-line no-process-exit -- operator CLI, not server code
    process.exit(1);
  },
);

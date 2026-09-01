/**
 * `pnpm flows:export [<workspaceId>]` — mirror existing flows into
 * `flows/<slug>.yml` (RFC #904 block 2).
 *
 * In-product mutations write their file through automatically; this is the
 * one-time backfill for flows that predate that, and the repair tool for a
 * workspace whose repo was connected after its flows were made. Idempotent:
 * a flow whose definition already matches its file makes no commit.
 *
 * Export-only by design — Mongo stays authoritative, so running this can
 * add or update files but never changes a flow.
 */
import "dotenv/config";
import mongoose from "mongoose";

import { Flow } from "../database/workspace-schema";
import { exportWorkspaceFlows } from "./flow-config.service";

async function main(): Promise<void> {
  const only = process.argv[2];
  const uri = process.env.DATABASE_URL;
  if (!uri) throw new Error("DATABASE_URL is not set");
  await mongoose.connect(uri);
  try {
    const workspaceIds = only
      ? [only]
      : (await Flow.distinct("workspaceId")).map(id => String(id));

    let written = 0;
    let skipped = 0;
    const allFailed: Array<{
      workspaceId: string;
      slug: string;
      error: string;
    }> = [];
    for (const workspaceId of workspaceIds) {
      const result = await exportWorkspaceFlows(workspaceId);
      written += result.written;
      skipped += result.skipped;
      for (const f of result.failed) allFailed.push({ workspaceId, ...f });
      console.log(
        `${workspaceId}: ${result.written} written, ${result.skipped} skipped (no slug/name), ` +
          `${result.failed.length} failed, commit=${result.commitMade}`,
      );
    }

    console.log(
      `\n${workspaceIds.length} workspace(s): ${written} file(s) written, ` +
        `${skipped} skipped, ${allFailed.length} failed.`,
    );
    if (skipped > 0) {
      console.log(
        "Skipped flows have no slug or name — run the flow_names_and_slugs migration first.",
      );
    }
    if (allFailed.length > 0) {
      console.error("\nFAILURES:");
      for (const f of allFailed) {
        console.error(`  ${f.workspaceId} ${f.slug}: ${f.error}`);
      }
      // A partial export must not look like success — reporting "10 written"
      // and exiting 0 while 21 flows failed is how the first production run
      // was mistaken for a working one.
      // eslint-disable-next-line no-process-exit -- operator CLI, not server code
      process.exit(1);
    }
  } finally {
    await mongoose.disconnect();
  }
}

main().catch(error => {
  console.error(error instanceof Error ? error.message : error);
  // eslint-disable-next-line no-process-exit -- operator CLI, not server code
  process.exit(1);
});

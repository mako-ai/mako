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
import { mirrorPushNow } from "../apps/cloud-repo.service";
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
    let unchanged = 0;
    let skipped = 0;
    const failed: string[] = [];
    for (const workspaceId of workspaceIds) {
      const result = await exportWorkspaceFlows(workspaceId);
      written += result.written;
      unchanged += result.unchanged;
      skipped += result.skipped;
      failed.push(...result.failed.map(slug => `${workspaceId}/${slug}`));
      console.log(
        `${workspaceId}: ${result.written} written, ${result.unchanged} unchanged, ` +
          `${result.skipped} skipped (no slug/name), ${result.failed.length} FAILED`,
      );
      // The push is fire-and-forget everywhere else, because a user's mutation
      // must not wait on GitHub. A CLI is the opposite case: if we exit before
      // the push runs, the commits stay in the local bare repo and the mirror
      // never sees them — a run that writes every file and pushes none, while
      // reporting success.
      if (result.written > 0) await mirrorPushNow(workspaceId);
    }

    console.log(
      `\n${workspaceIds.length} workspace(s): ${written} written, ` +
        `${unchanged} unchanged, ${skipped} skipped, ${failed.length} failed.`,
    );
    if (skipped > 0) {
      console.log(
        "Skipped flows have no slug or no name — run the flow_names_and_slugs migration first.",
      );
    }
    if (failed.length > 0) {
      // Exit non-zero. `commitFlowFile` deliberately swallows its errors so a
      // failed mirror never fails a user's mutation, which is right in the
      // request path and wrong here: it once let this CLI report
      // "10 written, 0 skipped" and exit 0 while 21 of 31 flows had thrown.
      console.error(`\nFAILED to export ${failed.length} flow(s):`);
      for (const slug of failed) console.error(`  ${slug}`);
      throw new Error(
        `${failed.length} flow(s) failed to export — see the warnings above`,
      );
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

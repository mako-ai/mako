/**
 * Backfill of stored thumbnail variants, and its on-boot trigger.
 *
 * The main-moved warm only fires when an instance reads the apps index,
 * which the hot image paths no longer do. So every instance, shortly after
 * boot, asks the warm function (debounced to one run) to walk the persisted
 * index rows of every workspace with raster thumbnails and fill whatever
 * the store is missing — the one-off backfill of existing posters, and
 * again whenever a deploy adds a variant recipe. Store hits are HEAD
 * requests; only a miss touches git.
 */
import { AppIndexEntry } from "../database/workspace-schema";
import { loggers } from "../logging";
import { loadIndexedApps } from "./app-index.service";
import {
  requestThumbnailWarm,
  warmEnabled,
  warmThumbnailVariants,
} from "./thumbnail-variants.service";

const logger = loggers.api("apps-thumbnail-variants");

/** Warm one workspace from its persisted index rows. */
export async function warmWorkspaceThumbnails(
  workspaceId: string,
): Promise<{ checked: number; generated: number }> {
  return warmThumbnailVariants(workspaceId, await loadIndexedApps(workspaceId));
}

/** Warm every workspace that has a thumbnail in its index. */
export async function backfillThumbnailVariants(): Promise<{
  workspaces: number;
  failed: number;
  checked: number;
  generated: number;
}> {
  const ids = await AppIndexEntry.distinct("workspaceId", {
    thumbnail: { $exists: true },
  });
  let checked = 0;
  let generated = 0;
  let failed = 0;
  for (const id of ids) {
    const workspaceId = String(id);
    try {
      const out = await warmWorkspaceThumbnails(workspaceId);
      checked += out.checked;
      generated += out.generated;
    } catch (error) {
      // One workspace's broken repo must not stop the others.
      failed++;
      logger.warn("thumbnail backfill failed for a workspace", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { workspaces: ids.length, failed, checked, generated };
}

/** Request the backfill a few seconds after boot (unref'd timer). */
export function scheduleThumbnailBackfillOnBoot(): void {
  if (!warmEnabled()) return;
  const timer = setTimeout(
    () => requestThumbnailWarm({ workspaceId: "*" }),
    10_000,
  );
  timer.unref();
}

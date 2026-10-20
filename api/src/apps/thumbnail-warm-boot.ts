/**
 * On-boot backfill of stored thumbnail variants.
 *
 * The main-moved warm (scheduleThumbnailWarm) only fires when an instance
 * reads the apps index, and the hot image paths no longer do. So each
 * instance, shortly after boot, walks the persisted index rows of every
 * workspace that has raster thumbnails and fills whatever the store is
 * missing — after a deploy that introduces a new variant recipe, or for a
 * poster nobody has asked for yet. Store hits are HEAD requests; only a
 * miss touches git (and, on a fresh instance, the mirror clone), so once
 * the first instance has filled the store the others do nothing.
 * Jittered so instances booting together do not race each other.
 */
import { AppIndexEntry } from "../database/workspace-schema";
import { loggers } from "../logging";
import { loadIndexedApps } from "./app-index.service";
import {
  warmEnabled,
  warmThumbnailVariants,
} from "./thumbnail-variants.service";

const logger = loggers.api("apps-thumbnail-variants");

/** Run the backfill for every workspace with a thumbnail in its index. */
export async function backfillThumbnailVariants(): Promise<{
  workspaces: number;
  checked: number;
  generated: number;
}> {
  const ids = await AppIndexEntry.distinct("workspaceId", {
    thumbnail: { $exists: true },
  });
  let checked = 0;
  let generated = 0;
  for (const id of ids) {
    const workspaceId = String(id);
    try {
      const apps = await loadIndexedApps(workspaceId);
      const out = await warmThumbnailVariants(workspaceId, apps);
      checked += out.checked;
      generated += out.generated;
    } catch (error) {
      logger.warn("thumbnail backfill failed for a workspace", {
        workspaceId,
        error,
      });
    }
  }
  return { workspaces: ids.length, checked, generated };
}

/** Schedule the backfill 20–80 s after boot (unref'd: never holds exit). */
export function scheduleThumbnailBackfillOnBoot(): void {
  if (!warmEnabled()) return;
  const delayMs = 20_000 + Math.floor(Math.random() * 60_000);
  const timer = setTimeout(() => {
    const started = Date.now();
    backfillThumbnailVariants()
      .then(out =>
        logger.info("thumbnail variant backfill done", {
          ...out,
          durationMs: Date.now() - started,
        }),
      )
      .catch(error =>
        logger.warn("thumbnail variant backfill failed", { error }),
      );
  }, delayMs);
  timer.unref();
}

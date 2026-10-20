/**
 * Pre-generate stored thumbnail variants (OG JPEG + 640w card WebP).
 *
 * Triggered when an instance sees main move (one workspace) and on every
 * instance boot (`workspaceId: "*"`, the backfill). Debounced per key so a
 * fleet booting together, or a burst of pushes, runs it once; idempotent —
 * variants already in the store are skipped with a HEAD. Runs here, inside
 * an Inngest request, because on request-billed Cloud Run CPU background
 * work outside a request is starved (apps/thumbnail-variants.service.ts).
 */
import { inngest } from "../client";
import { loggers } from "../../logging";
import {
  THUMBNAIL_WARM_EVENT,
  type ThumbnailWarmEventData,
} from "../../apps/thumbnail-variants.service";
import {
  backfillThumbnailVariants,
  warmWorkspaceThumbnails,
} from "../../apps/thumbnail-warm-boot";

const log = loggers.api("apps-thumbnail-warm");

export const appsThumbnailWarmFunction = inngest.createFunction(
  {
    id: "apps-thumbnail-warm",
    name: "Apps: pre-generate thumbnail variants",
    debounce: { key: "event.data.workspaceId", period: "30s", timeout: "5m" },
    concurrency: [{ key: "event.data.workspaceId", limit: 1 }],
    retries: 2,
    triggers: { event: THUMBNAIL_WARM_EVENT },
  },
  async ({ event, step }) => {
    const data = event.data as ThumbnailWarmEventData;
    const outcome = await step.run("warm", () =>
      data.workspaceId === "*"
        ? backfillThumbnailVariants()
        : warmWorkspaceThumbnails(data.workspaceId),
    );
    log.info("thumbnail variants warmed", {
      workspaceId: data.workspaceId,
      sha: data.sha,
      ...outcome,
    });
    return outcome;
  },
);

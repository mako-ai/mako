/**
 * Take an app's Apps home thumbnail (app-thumbnail.service) as Inngest work.
 *
 * Serial per workspace: every capture runs a headless browser in the one
 * publish box, and a backfill of a whole workspace must queue there rather
 * than launch a browser per app in a 2 GiB machine. One pending capture per
 * app is enough — a second request while one waits adds nothing.
 */
import { inngest } from "../client";
import { loggers } from "../../logging";
import {
  APPS_THUMBNAIL_EVENT,
  captureAppThumbnail,
  type AppsThumbnailEventData,
} from "../../apps/app-thumbnail.service";

const log = loggers.inngest();

export const appsThumbnailFunction = inngest.createFunction(
  {
    id: "apps-thumbnail",
    name: "Apps: capture an app's thumbnail",
    concurrency: [{ key: "event.data.workspaceId", limit: 1 }],
    singleton: {
      key: "event.data.workspaceId + '/' + event.data.appId",
      mode: "skip",
    },
    // A picture is never worth hammering the box over: one retry covers a
    // box that was mid-boot, then the card keeps its placeholder until the
    // next deploy (or the next request after the throttle) asks again.
    retries: 1,
    triggers: { event: APPS_THUMBNAIL_EVENT },
  },
  async ({ event, step }) => {
    const data = event.data as AppsThumbnailEventData;
    const outcome = await step.run("capture", () =>
      captureAppThumbnail(data.workspaceId, data.appId),
    );
    log.info("Apps thumbnail event handled", { ...data, outcome });
    return { outcome };
  },
);

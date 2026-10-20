/**
 * App thumbnails — a picture of each published app for the Apps home cards.
 *
 * Taken by the in-box browser that already exists for the agent's eyes
 * (eyes.service), in the workspace's PUBLISH box, against the deployment's
 * cookie-free token URL — the exact page a viewer gets, data included. No
 * dev server, no checkout, nothing new installed on the API host (N1). The
 * frame is a half-scale JPEG of the 1280×800 layout (~20–60 KB), stored in
 * the artifact store next to the deployment and served by a signed-URL
 * redirect, so a page of cards costs the API one small lookup per card.
 *
 * When: after a deploy goes live (deployBuild), and lazily for apps that
 * were published before thumbnails existed — the first card that asks for a
 * missing one enqueues it. Both go through one Inngest function, serial per
 * workspace, so a 100-app backfill is a queue in one box, not 100 browsers.
 * A failure costs the picture only; the card shows its generated placeholder.
 */
import { Types } from "mongoose";
import { inngest } from "../inngest/client";
import { AppProject, type IAppProject } from "../database/workspace-schema";
import {
  getArtifactSourceStore,
  getArtifactStore,
} from "../services/artifact-store.service";
import { loggers } from "../logging";
import { captureScreenshot } from "./eyes.service";
import { mintPublishedGrant } from "./preview.service";
import { appsGitOriginBase } from "./config";
import { getSandboxProvider } from "./sandbox/provider";
import { PUBLISH_ACTOR, sessionKeyFor } from "./worktree.service";

const logger = loggers.api("apps-thumbnail");

export const APPS_THUMBNAIL_EVENT = "apps/thumbnail.requested";

export interface AppsThumbnailEventData {
  workspaceId: string;
  appId: string;
}

/** Immutable per deployment, like the deployment itself. */
export function thumbnailKey(projectId: string, sha: string): string {
  return `apps/${projectId}/thumbnails/${sha}.jpg`;
}

/** Whether the app's current deployment has its picture already. */
export function thumbnailIsFresh(
  project: Pick<IAppProject, "publishedSha" | "thumbnail">,
): boolean {
  return (
    !!project.publishedSha && project.thumbnail?.sha === project.publishedSha
  );
}

/**
 * Per-process memo of recent requests: a page of cards for apps without a
 * picture must enqueue each one once, not once per render. Inngest dedupes
 * across instances too (singleton per app); this just keeps the event volume
 * down.
 */
const recentlyRequested = new Map<string, number>();
const REQUEST_THROTTLE_MS = 15 * 60 * 1000;

/**
 * Whether this environment takes pictures at all. Not with the local
 * provider (it has no browser: eyes refuse to run tenant JS on the API
 * host), and not in a rehearsal environment — a PR preview reads prod's
 * artifacts (APPS_ARTIFACT_SOURCE_BUCKET) and shares prod's sandboxes, so a
 * backfill there would run prod's publish box for pictures prod never sees.
 * APPS_THUMBNAILS=on|off overrides.
 */
export function thumbnailsEnabled(): boolean {
  const flag = (process.env.APPS_THUMBNAILS || "").toLowerCase();
  if (flag === "off" || flag === "false" || flag === "0") return false;
  if (getSandboxProvider().id === "local") return false;
  if (flag === "on" || flag === "true" || flag === "1") return true;
  return !getArtifactSourceStore();
}

/** Ask for a (re)take. Never throws: a thumbnail is never worth a failure. */
export async function requestAppThumbnail(
  workspaceId: string,
  appId: string,
): Promise<void> {
  if (!thumbnailsEnabled()) return;
  const key = `${workspaceId}/${appId}`;
  const now = Date.now();
  const last = recentlyRequested.get(key);
  if (last && now - last < REQUEST_THROTTLE_MS) return;
  recentlyRequested.set(key, now);
  if (recentlyRequested.size > 5_000) {
    for (const [k, at] of recentlyRequested) {
      if (now - at > REQUEST_THROTTLE_MS) recentlyRequested.delete(k);
    }
  }
  try {
    await inngest.send({
      name: APPS_THUMBNAIL_EVENT,
      data: { workspaceId, appId } satisfies AppsThumbnailEventData,
    });
  } catch (error) {
    recentlyRequested.delete(key);
    logger.warn("Could not enqueue an app thumbnail", {
      workspaceId,
      appId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

export type ThumbnailOutcome =
  "captured" | "fresh" | "unpublished" | "unsupported" | "failed";

/** Take the picture of the app's live deployment and remember it. */
export async function captureAppThumbnail(
  workspaceId: string,
  appId: string,
): Promise<ThumbnailOutcome> {
  if (!thumbnailsEnabled()) return "unsupported";
  if (!Types.ObjectId.isValid(appId)) return "unpublished";
  const project = await AppProject.findOne({
    _id: new Types.ObjectId(appId),
    workspaceId: new Types.ObjectId(workspaceId),
  })
    .select("_id workspaceId publishedSha thumbnail")
    .lean();
  const sha = project?.publishedSha;
  if (!project || !sha) return "unpublished";
  if (thumbnailIsFresh(project)) return "fresh";

  // Anonymous on purpose: the picture hangs on a card every member sees, so
  // it must not show what one particular viewer's useViewer() unlocks.
  const grant = mintPublishedGrant({ workspaceId, projectId: appId, sha });
  const url = `${appsGitOriginBase()}/api/apps-preview/${grant.token}/`;
  const shot = await captureScreenshot(
    { sessionKey: sessionKeyFor(workspaceId, PUBLISH_ACTOR) },
    url,
    { scale: 0.5 },
  );
  if (!shot.ok) {
    logger.warn("App thumbnail capture failed", {
      workspaceId,
      appId,
      sha,
      error: shot.error.slice(0, 500),
    });
    return "failed";
  }
  const key = thumbnailKey(appId, sha);
  await getArtifactStore().putBuffer(shot.jpeg, key, "image/jpeg", {
    projectId: appId,
    sha,
  });
  // Not an edit of the app: keep updatedAt (sorting, "recently changed")
  // about the app, not about its picture.
  await AppProject.updateOne(
    { _id: project._id, workspaceId: project.workspaceId },
    { $set: { thumbnail: { sha, key, at: new Date() } } },
    { timestamps: false },
  );
  logger.info("App thumbnail captured", {
    workspaceId,
    appId,
    sha,
    bytes: shot.jpeg.length,
  });
  return "captured";
}

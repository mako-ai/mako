/**
 * The lifecycle state the usage and discovery paths read
 * (app-usage.service.ts, app-discovery.service.ts), kept apart from
 * app-lifecycle.service.ts so neither imports the job that imports them.
 */
import { parseEntityId } from "../database/pg/id-codec";
import { appsMetadataRepo } from "../repositories/apps-metadata";

/**
 * Someone opened the app: resume its paused binding schedules and cancel a
 * pending stale archive. One indexed no-op update when the app has no
 * lifecycle state, so it is safe on every open.
 */
export async function onAppOpened(
  workspaceId: string,
  appId: string,
): Promise<void> {
  if (!parseEntityId(workspaceId)) return;
  await appsMetadataRepo.clearStaleAndPausedOnOpen(workspaceId, appId);
}

/**
 * Verified app ids of a workspace — what `verified` on the app list and on
 * the Apps home is read from.
 */
export async function verifiedAppIds(
  workspaceId: string,
): Promise<Set<string>> {
  const ids = await appsMetadataRepo.listVerifiedAppIds(workspaceId);
  return new Set(ids);
}

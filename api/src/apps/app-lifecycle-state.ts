/**
 * The lifecycle state the usage and discovery paths read
 * (app-usage.service.ts, app-discovery.service.ts), kept apart from
 * app-lifecycle.service.ts so neither imports the job that imports them.
 */
import { Types } from "mongoose";
import { AppLifecycleState } from "../database/workspace-schema";

/**
 * Someone opened the app: resume its paused binding schedules and cancel a
 * pending stale archive. One indexed no-op update when the app has no
 * lifecycle state, so it is safe on every open.
 */
export async function onAppOpened(
  workspaceId: string,
  appId: string,
): Promise<void> {
  if (!Types.ObjectId.isValid(workspaceId)) return;
  await AppLifecycleState.updateOne(
    {
      workspaceId: new Types.ObjectId(workspaceId),
      appId,
      $or: [
        { schedulesPausedAt: { $exists: true } },
        { staleSince: { $exists: true } },
      ],
    },
    { $unset: { schedulesPausedAt: 1, staleSince: 1, staleNotifiedTo: 1 } },
  );
}

/**
 * Verified app ids of a workspace — what `verified` on the app list and on
 * the Apps home is read from.
 */
export async function verifiedAppIds(
  workspaceId: string,
): Promise<Set<string>> {
  const ids = await AppLifecycleState.distinct("appId", {
    workspaceId: new Types.ObjectId(workspaceId),
    verifiedAt: { $exists: true },
  });
  return new Set(ids.map(String));
}

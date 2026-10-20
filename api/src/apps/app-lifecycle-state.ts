/**
 * The one lifecycle hook the usage path calls (app-usage.service.ts), kept
 * apart from app-lifecycle.service.ts so the usage service does not import
 * the job that imports it.
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

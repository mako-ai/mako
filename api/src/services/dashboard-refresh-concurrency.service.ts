import { Types } from "mongoose";
import { MaterializationRun, Workspace } from "../database/workspace-schema";

/** Default when workspace setting is unset. */
export const DEFAULT_DASHBOARD_REFRESH_CONCURRENCY = 2;

/**
 * Hard ceiling for Inngest concurrency + workspace setting clamp.
 * Soft per-workspace limit comes from Workspace.settings.dashboardRefreshConcurrency.
 */
export const DASHBOARD_REFRESH_CONCURRENCY_MAX = Math.max(
  parseInt(
    process.env.DASHBOARD_REFRESH_CONCURRENCY_PER_WORKSPACE_MAX || "10",
    10,
  ) || 10,
  1,
);

export function clampDashboardRefreshConcurrency(value: unknown): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? parseInt(value, 10)
        : NaN;
  if (!Number.isFinite(n)) {
    return DEFAULT_DASHBOARD_REFRESH_CONCURRENCY;
  }
  return Math.min(
    DASHBOARD_REFRESH_CONCURRENCY_MAX,
    Math.max(1, Math.floor(n)),
  );
}

export async function getWorkspaceDashboardRefreshConcurrency(
  workspaceId: string,
): Promise<number> {
  const workspace = await Workspace.findById(workspaceId)
    .select("settings.dashboardRefreshConcurrency")
    .lean();
  return clampDashboardRefreshConcurrency(
    workspace?.settings?.dashboardRefreshConcurrency,
  );
}

/**
 * Distinct dashboards currently building in this workspace.
 * Queued-only runs are excluded so enqueue storms cannot deadlock the soft gate
 * (Inngest concurrency + RetryAfterError drain the queue).
 */
export async function countBuildingDashboardRefreshes(
  workspaceId: string,
  options?: { excludeDashboardId?: string },
): Promise<number> {
  const match: Record<string, unknown> = {
    workspaceId: new Types.ObjectId(workspaceId),
    status: "building",
  };
  if (options?.excludeDashboardId) {
    match.dashboardId = {
      $ne: new Types.ObjectId(options.excludeDashboardId),
    };
  }

  const rows = await MaterializationRun.aggregate<{ n: number }>([
    { $match: match },
    { $group: { _id: "$dashboardId" } },
    { $count: "n" },
  ]);
  return rows[0]?.n ?? 0;
}

/**
 * True when another refresh should wait: other dashboards already occupy the
 * workspace concurrency budget.
 */
export async function shouldDeferDashboardRefresh(input: {
  workspaceId: string;
  dashboardId: string;
  limit?: number;
}): Promise<{ defer: boolean; activeOthers: number; limit: number }> {
  const limit =
    input.limit ??
    (await getWorkspaceDashboardRefreshConcurrency(input.workspaceId));
  const activeOthers = await countBuildingDashboardRefreshes(
    input.workspaceId,
    {
      excludeDashboardId: input.dashboardId,
    },
  );
  return { defer: activeOthers >= limit, activeOthers, limit };
}

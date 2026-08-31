import { Types } from "mongoose";
import { MaterializationRun, Workspace } from "../database/workspace-schema";

/** Defaults when workspace settings are unset. */
export const DEFAULT_DASHBOARD_REFRESH_CONCURRENCY = 2;

/**
 * Hard ceilings for Inngest concurrency + workspace setting clamps.
 * Soft per-workspace limits come from Workspace.settings.*.
 */
export const DASHBOARD_REFRESH_CONCURRENCY_MAX = Math.max(
  parseInt(
    process.env.DASHBOARD_REFRESH_CONCURRENCY_PER_WORKSPACE_MAX || "10",
    10,
  ) || 10,
  1,
);

function parseConcurrency(
  value: unknown,
  fallback: number,
  max: number,
): number {
  const n =
    typeof value === "number"
      ? value
      : typeof value === "string"
        ? parseInt(value, 10)
        : NaN;
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(1, Math.floor(n)));
}

export function clampDashboardRefreshConcurrency(value: unknown): number {
  return parseConcurrency(
    value,
    DEFAULT_DASHBOARD_REFRESH_CONCURRENCY,
    DASHBOARD_REFRESH_CONCURRENCY_MAX,
  );
}

export async function getWorkspaceRefreshLimits(workspaceId: string): Promise<{
  dashboardRefreshConcurrency: number;
}> {
  const workspace = await Workspace.findById(workspaceId)
    .select("settings.dashboardRefreshConcurrency")
    .lean();
  return {
    dashboardRefreshConcurrency: clampDashboardRefreshConcurrency(
      workspace?.settings?.dashboardRefreshConcurrency,
    ),
  };
}

export async function getWorkspaceDashboardRefreshConcurrency(
  workspaceId: string,
): Promise<number> {
  const limits = await getWorkspaceRefreshLimits(workspaceId);
  return limits.dashboardRefreshConcurrency;
}

/**
 * Distinct dashboards currently building in this workspace.
 * Queued-only runs are excluded so enqueue storms cannot deadlock the soft gate.
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
 * Parquet bindings currently building in this workspace.
 * Queued-only bindings are excluded (same rationale as dashboards).
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
    { excludeDashboardId: input.dashboardId },
  );
  return { defer: activeOthers >= limit, activeOthers, limit };
}

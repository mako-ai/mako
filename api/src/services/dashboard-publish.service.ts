import crypto from "crypto";
import { Dashboard, type IDashboard } from "../database/workspace-schema";
import { loggers } from "../logging";
import { buildDashboardMaterializationStatus } from "./dashboard-materialization.service";
import { queueDashboardArtifactRefresh } from "./dashboard-refresh-runner.service";

const logger = loggers.api("dashboard-publish");

function sleep(ms: number): Promise<void> {
  return new Promise(resolve => setTimeout(resolve, ms));
}

const PUBLISH_MATERIALIZATION_POLL_MS = 2_000;
const PUBLISH_MATERIALIZATION_MAX_WAIT_MS = 120_000;

/**
 * Ensures dashboard parquet artifacts exist so a public snapshot can be built.
 * Queues the same refresh path as manual materialize, then polls until ready or timeout.
 */
export async function ensureDashboardMaterializedForPublish(
  dashboardId: string,
  workspaceId: string,
): Promise<{ ok: true; dashboard: IDashboard } | { ok: false; error: string }> {
  const fresh = await Dashboard.findById(dashboardId);
  if (!fresh) {
    return { ok: false, error: "Dashboard not found" };
  }
  if (fresh.workspaceId.toString() !== workspaceId) {
    return { ok: false, error: "Dashboard not found" };
  }

  let status = await buildDashboardMaterializationStatus(fresh);
  if (status.allReady) {
    return { ok: true, dashboard: fresh };
  }

  try {
    await queueDashboardArtifactRefresh({
      dashboardId,
      workspaceId,
      force: true,
      triggerType: "manual",
    });
  } catch (error) {
    logger.error("Failed to queue dashboard materialization for publish", {
      error,
      dashboardId,
    });
    return {
      ok: false,
      error:
        "Could not start materialization. Check that background jobs (Inngest) are running, then try Publish again.",
    };
  }

  const deadline = Date.now() + PUBLISH_MATERIALIZATION_MAX_WAIT_MS;

  while (Date.now() < deadline) {
    await sleep(PUBLISH_MATERIALIZATION_POLL_MS);
    const doc = await Dashboard.findById(dashboardId);
    if (!doc) {
      return { ok: false, error: "Dashboard not found" };
    }
    status = await buildDashboardMaterializationStatus(doc);
    if (status.allReady) {
      return { ok: true, dashboard: doc };
    }

    if (
      !status.anyBuilding &&
      status.dataSources.some(ds => ds.status === "error")
    ) {
      const parts = status.dataSources
        .filter(ds => ds.status === "error" && ds.lastError)
        .map(ds => `${ds.name}: ${ds.lastError}`);
      return {
        ok: false,
        error:
          parts.length > 0
            ? `Materialization failed: ${parts.join(" | ")}`
            : "Materialization failed. Fix the data sources and try Publish again.",
      };
    }
  }

  return {
    ok: false,
    error:
      "Materialization is still in progress after waiting two minutes. Try Publish again in a moment once data sources show Ready.",
  };
}

export function hashDashboardShareToken(token: string): string {
  return crypto.createHash("sha256").update(token, "utf8").digest("hex");
}

export function newDashboardShareToken(): string {
  return crypto.randomBytes(32).toString("base64url");
}

export interface DashboardPublishedArtifactSnapshot {
  dataSourceId: string;
  name: string;
  artifactKey: string;
  artifactRevision: string | null;
  rowCount: number | null;
  byteSize: number | null;
}

export interface DashboardPublishedSnapshotDoc {
  title: string;
  layout: { columns: number; rowHeight: number };
  theme?: "light" | "dark";
  widgets: Array<Record<string, unknown>>;
  artifacts: DashboardPublishedArtifactSnapshot[];
}

export async function buildDashboardPublishedSnapshot(
  dashboard: IDashboard,
): Promise<
  | { ok: true; snapshot: DashboardPublishedSnapshotDoc }
  | { ok: false; error: string }
> {
  if (!dashboard.dataSources?.length) {
    return { ok: false, error: "Dashboard has no data sources to publish." };
  }

  const status = await buildDashboardMaterializationStatus(dashboard);
  if (!status.allReady) {
    return {
      ok: false,
      error:
        "All data sources must be materialized (ready) before publishing. Use Publish from the dashboard settings to run materialization automatically, or refresh materialization manually.",
    };
  }

  const artifacts: DashboardPublishedArtifactSnapshot[] = [];
  for (const ds of status.dataSources) {
    if (!ds.artifactKey) {
      return {
        ok: false,
        error: `Missing artifact for data source "${ds.name}".`,
      };
    }
    artifacts.push({
      dataSourceId: ds.dataSourceId,
      name: ds.name,
      artifactKey: ds.artifactKey,
      artifactRevision: ds.artifactRevision,
      rowCount: ds.rowCount,
      byteSize: ds.byteSize,
    });
  }

  const widgets = (dashboard.widgets || []).map(w => ({
    id: w.id,
    title: w.title,
    type: w.type,
    dataSourceId: w.dataSourceId,
    localSql: w.localSql,
    vegaLiteSpec: w.vegaLiteSpec,
    kpiConfig: w.kpiConfig,
    tableConfig: w.tableConfig,
    layouts: w.layouts,
  }));

  return {
    ok: true,
    snapshot: {
      title: dashboard.title,
      layout: {
        columns: dashboard.layout?.columns ?? 12,
        rowHeight: dashboard.layout?.rowHeight ?? 80,
      },
      theme: "light",
      widgets,
      artifacts,
    },
  };
}

export function embedPayloadFromPublishedSnapshot(
  snapshot: DashboardPublishedSnapshotDoc,
  shareToken: string,
): Record<string, unknown> {
  const enc = encodeURIComponent;
  return {
    title: snapshot.title,
    layout: snapshot.layout,
    theme: snapshot.theme ?? "light",
    widgets: snapshot.widgets,
    dataSources: snapshot.artifacts.map(a => ({
      id: a.dataSourceId,
      name: a.name,
      exportUrl: `/api/public/dashboards/${enc(shareToken)}/artifacts/${enc(a.dataSourceId)}${
        a.artifactRevision ? `?rev=${enc(a.artifactRevision)}` : ""
      }`,
    })),
  };
}

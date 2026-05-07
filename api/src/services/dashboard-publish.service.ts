import crypto from "crypto";
import type { IDashboard } from "../database/workspace-schema";
import { buildDashboardMaterializationStatus } from "./dashboard-materialization.service";

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
        "All data sources must be materialized (ready) before publishing. Run materialization and try again.",
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

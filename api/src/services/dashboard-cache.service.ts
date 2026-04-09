import type { IDashboard } from "../database/workspace-schema";
import {
  getDashboardArtifactStore,
  type DashboardArtifactStore,
} from "./dashboard-artifact-store.service";

const artifactBuildLocks = new Map<string, Promise<void>>();

export interface DashboardArtifactDescriptor {
  key: string;
  version: string;
  builtAt: Date;
  expiresAt?: Date;
  byteSize?: number;
  rowCount?: number;
}

function getDashboardArtifactPrefix(): string {
  const rawPrefix = process.env.DASHBOARD_ARTIFACT_PREFIX;
  if (rawPrefix) {
    return rawPrefix.replace(/^\/+|\/+$/g, "");
  }

  if (process.env.PR_NUMBER) {
    return `dashboard-artifacts/pr-${process.env.PR_NUMBER}`;
  }

  if (process.env.NODE_ENV === "production") {
    return "dashboard-artifacts/prod";
  }

  return "dashboards";
}

export function buildDashboardArtifactKey(input: {
  workspaceId: string;
  dashboardId: string;
  dataSourceId: string;
  definitionHash: string;
}): string {
  const prefix = getDashboardArtifactPrefix();
  return `${prefix}/workspaces/${input.workspaceId}/dashboards/${input.dashboardId}/dataSources/${input.dataSourceId}/${input.definitionHash}.parquet`;
}

export function buildDashboardMaterializationArtifactPath(input: {
  workspaceId: string;
  dashboardId: string;
  dataSourceId: string;
  revision?: string;
}): string {
  const base = `/api/workspaces/${input.workspaceId}/dashboards/${input.dashboardId}/data-sources/${input.dataSourceId}/materialization/artifact`;
  const params = new URLSearchParams();
  if (input.revision) {
    params.set("rev", input.revision);
  }
  const query = params.toString();
  return query ? `${base}?${query}` : base;
}

export function buildSnapshotArtifactKey(input: {
  workspaceId: string;
  dashboardId: string;
  widgetId: string;
  version: string;
}): string {
  const prefix = getDashboardArtifactPrefix();
  return `${prefix}/workspaces/${input.workspaceId}/dashboards/${input.dashboardId}/widgets/${input.widgetId}/${input.version}.json`;
}

export function resolveDashboardArtifactRevision(cache?: {
  artifactRevision?: string | null;
  parquetBuiltAt?: Date | string | null;
}): string | null {
  const artifactRevision = cache?.artifactRevision || null;
  if (!cache?.parquetBuiltAt) {
    return artifactRevision;
  }
  const builtAt =
    cache.parquetBuiltAt instanceof Date
      ? cache.parquetBuiltAt
      : new Date(cache.parquetBuiltAt);
  const builtAtMs = builtAt.getTime();
  const builtAtRevision = Number.isFinite(builtAtMs) ? String(builtAtMs) : null;

  if (!artifactRevision || !builtAtRevision) {
    return artifactRevision || builtAtRevision;
  }

  const artifactRevisionMs = Number(artifactRevision);
  if (Number.isFinite(artifactRevisionMs) && artifactRevisionMs < builtAtMs) {
    return builtAtRevision;
  }

  return artifactRevision;
}

export function getArtifactStore(): DashboardArtifactStore {
  return getDashboardArtifactStore();
}

export async function artifactExists(key: string): Promise<boolean> {
  return await getArtifactStore().exists(key);
}

export async function storeArtifact(
  localPath: string,
  key: string,
  metadata?: Record<string, string>,
): Promise<void> {
  await getArtifactStore().put(localPath, key, metadata);
}

export async function deleteArtifact(key: string): Promise<void> {
  await getArtifactStore().delete(key);
}

export async function withArtifactBuildLock<T>(
  key: string,
  fn: () => Promise<T>,
): Promise<T> {
  const existing = artifactBuildLocks.get(key);
  if (existing) {
    await existing;
    return await fn();
  }

  let resolveLock = () => {};
  const lock = new Promise<void>(resolve => {
    resolveLock = resolve;
  });

  artifactBuildLocks.set(key, lock);
  try {
    return await fn();
  } finally {
    resolveLock();
    artifactBuildLocks.delete(key);
  }
}

export async function hydrateDashboardArtifactUrls<
  T extends Pick<IDashboard, "dataSources" | "workspaceId" | "_id">,
>(dashboard: T): Promise<T> {
  const workspaceId = dashboard.workspaceId.toString();
  const dashboardId = dashboard._id.toString();
  const dataSources = await Promise.all(
    dashboard.dataSources.map(async ds => {
      const artifactKey = ds.cache?.parquetArtifactKey;
      if (!artifactKey) {
        return ds;
      }

      return {
        ...ds,
        cache: {
          ...ds.cache,
          parquetUrl: buildDashboardMaterializationArtifactPath({
            workspaceId,
            dashboardId,
            dataSourceId: String(ds.id),
            revision: resolveDashboardArtifactRevision(ds.cache) || undefined,
          }),
        },
      };
    }),
  );

  return {
    ...dashboard,
    dataSources,
  };
}

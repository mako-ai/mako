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

export function buildDashboardArtifactKey(input: {
  workspaceId: string;
  dashboardId: string;
  dataSourceId: string;
  version: string;
}): string {
  const prefix = (
    process.env.DASHBOARD_ARTIFACT_PREFIX || "dashboards"
  ).replace(/^\/+|\/+$/g, "");
  return `${prefix}/workspaces/${input.workspaceId}/dashboards/${input.dashboardId}/dataSources/${input.dataSourceId}/${input.version}.parquet`;
}

export function buildSnapshotArtifactKey(input: {
  workspaceId: string;
  dashboardId: string;
  widgetId: string;
  version: string;
}): string {
  const prefix = (
    process.env.DASHBOARD_ARTIFACT_PREFIX || "dashboards"
  ).replace(/^\/+|\/+$/g, "");
  return `${prefix}/workspaces/${input.workspaceId}/dashboards/${input.dashboardId}/widgets/${input.widgetId}/${input.version}.json`;
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

export async function resolveArtifactUrl(key: string): Promise<string> {
  return await getArtifactStore().getUrl(key);
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
  T extends Pick<IDashboard, "dataSources">,
>(dashboard: T): Promise<T> {
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
          parquetUrl: await resolveArtifactUrl(artifactKey),
        },
      };
    }),
  );

  return {
    ...dashboard,
    dataSources,
  };
}

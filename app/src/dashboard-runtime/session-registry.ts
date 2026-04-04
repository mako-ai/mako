import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import {
  createDuckDBInstance,
  terminateTrackedDuckDBInstance,
} from "../lib/duckdb";
import { createMosaicInstance, type MosaicInstance } from "../lib/mosaic";

export interface DashboardSessionHandle {
  dashboardId: string;
  sessionId: string;
  db: AsyncDuckDB;
  persistent: false;
  dataSourceVersions: Map<string, string>;
  activeLoads: Map<string, Promise<void>>;
  mosaic: MosaicInstance | null;
}

const sessions = new Map<string, DashboardSessionHandle>();
const pendingCreations = new Map<string, Promise<DashboardSessionHandle>>();

async function createSession(
  dashboardId: string,
): Promise<DashboardSessionHandle> {
  const db = await createDuckDBInstance();

  const session: DashboardSessionHandle = {
    dashboardId,
    sessionId: crypto.randomUUID(),
    db,
    persistent: false,
    dataSourceVersions: new Map(),
    activeLoads: new Map(),
    mosaic: null,
  };
  sessions.set(dashboardId, session);
  return session;
}

export async function ensureDashboardSession(
  dashboardId: string,
): Promise<DashboardSessionHandle> {
  const existing = sessions.get(dashboardId);
  if (existing) {
    return existing;
  }

  const pending = pendingCreations.get(dashboardId);
  if (pending) {
    return pending;
  }

  const creation = createSession(dashboardId).finally(() => {
    pendingCreations.delete(dashboardId);
  });
  pendingCreations.set(dashboardId, creation);
  return creation;
}

export function getDashboardSession(
  dashboardId: string,
): DashboardSessionHandle | null {
  return sessions.get(dashboardId) || null;
}

export async function checkpointSession(_dashboardId: string): Promise<void> {
  // No-op: sessions are in-memory only.
}

export async function ensureMosaicInstance(
  dashboardId: string,
): Promise<MosaicInstance> {
  const session = await ensureDashboardSession(dashboardId);
  if (session.mosaic) {
    return session.mosaic;
  }

  session.mosaic = await createMosaicInstance(session.db);
  return session.mosaic;
}

export function getMosaicInstance(dashboardId: string): MosaicInstance | null {
  return sessions.get(dashboardId)?.mosaic || null;
}

export async function persistDataSourceVersion(
  _dashboardId: string,
  dataSourceId: string,
  loadedVersion: string,
  _tableRef: string,
  _rowCount: number,
): Promise<void> {
  const session = sessions.get(_dashboardId);
  if (session) {
    session.dataSourceVersions.set(dataSourceId, loadedVersion);
  }
}

export async function removePersistedDataSource(
  dashboardId: string,
  dataSourceId: string,
): Promise<void> {
  const session = sessions.get(dashboardId);
  if (session) {
    session.dataSourceVersions.delete(dataSourceId);
  }
}

export async function disposeDashboardSession(
  dashboardId: string,
): Promise<void> {
  const session = sessions.get(dashboardId);
  if (!session) {
    return;
  }

  if (session.mosaic) {
    try {
      session.mosaic.destroy();
    } catch {
      // Best-effort cleanup when coordinator teardown fails.
    }
    session.mosaic = null;
  }

  pendingCreations.delete(dashboardId);
  sessions.delete(dashboardId);
  await terminateTrackedDuckDBInstance(
    session.db,
    `disposeDashboardSession:${dashboardId}`,
  );
}

export async function destroyDashboardStorage(
  dashboardId: string,
): Promise<void> {
  await disposeDashboardSession(dashboardId);
}

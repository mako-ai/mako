import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import { createDuckDBInstance } from "../lib/duckdb";

export interface DashboardSessionHandle {
  dashboardId: string;
  sessionId: string;
  db: AsyncDuckDB;
  dataSourceVersions: Map<string, string>;
  activeLoads: Map<string, Promise<void>>;
}

const sessions = new Map<string, DashboardSessionHandle>();

export async function ensureDashboardSession(
  dashboardId: string,
): Promise<DashboardSessionHandle> {
  const existing = sessions.get(dashboardId);
  if (existing) {
    return existing;
  }

  const db = await createDuckDBInstance();
  const session: DashboardSessionHandle = {
    dashboardId,
    sessionId: crypto.randomUUID(),
    db,
    dataSourceVersions: new Map(),
    activeLoads: new Map(),
  };
  sessions.set(dashboardId, session);
  return session;
}

export function getDashboardSession(
  dashboardId: string,
): DashboardSessionHandle | null {
  return sessions.get(dashboardId) || null;
}

export async function disposeDashboardSession(
  dashboardId: string,
): Promise<void> {
  const session = sessions.get(dashboardId);
  if (!session) {
    return;
  }

  sessions.delete(dashboardId);
  await (session.db as any).terminate?.();
}

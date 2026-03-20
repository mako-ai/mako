import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import {
  createDuckDBInstance,
  createPersistentDuckDBInstance,
  checkpointDatabase,
  deleteOPFSFiles,
  isOPFSAvailable,
} from "../lib/duckdb";
import { createMosaicInstance, type MosaicInstance } from "../lib/mosaic";

export interface DashboardSessionHandle {
  dashboardId: string;
  sessionId: string;
  db: AsyncDuckDB;
  persistent: boolean;
  dataSourceVersions: Map<string, string>;
  activeLoads: Map<string, Promise<void>>;
  mosaic: MosaicInstance | null;
}

const sessions = new Map<string, DashboardSessionHandle>();

const METADATA_TABLE = "_mako_ds_versions";

function opfsPath(dashboardId: string): string {
  return `opfs://mako_dashboard_${dashboardId}.db`;
}

async function initMetadataTable(db: AsyncDuckDB): Promise<void> {
  const conn = await db.connect();
  try {
    await conn.query(
      `CREATE TABLE IF NOT EXISTS "${METADATA_TABLE}" (
        data_source_id VARCHAR PRIMARY KEY,
        version_hash VARCHAR NOT NULL,
        table_ref VARCHAR NOT NULL,
        row_count INTEGER DEFAULT 0
      )`,
    );
  } finally {
    await conn.close();
  }
}

async function loadPersistedVersions(
  db: AsyncDuckDB,
): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  const conn = await db.connect();
  try {
    const result = await conn.query(
      `SELECT data_source_id, version_hash FROM "${METADATA_TABLE}"`,
    );
    for (let i = 0; i < result.numRows; i++) {
      const dsId = String(result.getChild("data_source_id")?.get(i));
      const hash = String(result.getChild("version_hash")?.get(i));
      versions.set(dsId, hash);
    }
  } catch {
    // Table may not exist on first run
  } finally {
    await conn.close();
  }
  return versions;
}

export async function ensureDashboardSession(
  dashboardId: string,
): Promise<DashboardSessionHandle> {
  const existing = sessions.get(dashboardId);
  if (existing) {
    return existing;
  }

  let db: AsyncDuckDB;
  let persistent = false;
  let dataSourceVersions = new Map<string, string>();

  if (isOPFSAvailable()) {
    try {
      db = await createPersistentDuckDBInstance(opfsPath(dashboardId));
      persistent = true;
      await initMetadataTable(db);
      dataSourceVersions = await loadPersistedVersions(db);
    } catch {
      db = await createDuckDBInstance();
    }
  } else {
    db = await createDuckDBInstance();
  }

  const session: DashboardSessionHandle = {
    dashboardId,
    sessionId: crypto.randomUUID(),
    db,
    persistent,
    dataSourceVersions,
    activeLoads: new Map(),
    mosaic: null,
  };
  sessions.set(dashboardId, session);
  return session;
}

export function getDashboardSession(
  dashboardId: string,
): DashboardSessionHandle | null {
  return sessions.get(dashboardId) || null;
}

export async function checkpointSession(dashboardId: string): Promise<void> {
  const session = sessions.get(dashboardId);
  if (!session?.persistent) return;
  await checkpointDatabase(session.db);
}

export async function persistDataSourceVersion(
  dashboardId: string,
  dataSourceId: string,
  versionHash: string,
  tableRef: string,
  rowCount: number,
): Promise<void> {
  const session = sessions.get(dashboardId);
  if (!session?.persistent) return;

  const conn = await session.db.connect();
  try {
    await conn.query(
      `INSERT OR REPLACE INTO "${METADATA_TABLE}"
        (data_source_id, version_hash, table_ref, row_count)
       VALUES ('${dataSourceId}', '${versionHash}', '${tableRef}', ${rowCount})`,
    );
  } finally {
    await conn.close();
  }
}

export async function removePersistedDataSource(
  dashboardId: string,
  dataSourceId: string,
): Promise<void> {
  const session = sessions.get(dashboardId);
  if (!session?.persistent) return;

  const conn = await session.db.connect();
  try {
    await conn.query(
      `DELETE FROM "${METADATA_TABLE}" WHERE data_source_id = '${dataSourceId}'`,
    );
  } catch {
    // Metadata table may not exist
  } finally {
    await conn.close();
  }
}

/**
 * Lazily create a MosaicInstance for the given dashboard session.
 * Returns the existing instance if already created.
 */
export async function ensureMosaicInstance(
  dashboardId: string,
): Promise<MosaicInstance | null> {
  const session = sessions.get(dashboardId);
  if (!session) return null;
  if (session.mosaic) return session.mosaic;

  try {
    session.mosaic = await createMosaicInstance(session.db);
    return session.mosaic;
  } catch {
    return null;
  }
}

export function getMosaicInstance(dashboardId: string): MosaicInstance | null {
  return sessions.get(dashboardId)?.mosaic ?? null;
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
      // best-effort cleanup
    }
    session.mosaic = null;
  }

  if (session.persistent) {
    await checkpointDatabase(session.db).catch(() => {});
  }

  sessions.delete(dashboardId);
  await (session.db as any).terminate?.();
}

export async function destroyDashboardStorage(
  dashboardId: string,
): Promise<void> {
  await disposeDashboardSession(dashboardId);
  await deleteOPFSFiles(dashboardId);
}

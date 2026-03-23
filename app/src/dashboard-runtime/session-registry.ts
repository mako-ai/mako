/* eslint-disable no-console */
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import {
  createDuckDBInstance,
  createPersistentDuckDBInstance,
  checkpointDatabase,
  deleteOPFSFiles,
  isOPFSAvailable,
  type PersistentDuckDBAccessMode,
} from "../lib/duckdb";
import { createMosaicInstance, type MosaicInstance } from "../lib/mosaic";

export interface DashboardSessionHandle {
  dashboardId: string;
  sessionId: string;
  db: AsyncDuckDB;
  opfsAvailable: boolean;
  persistent: boolean;
  accessMode: PersistentDuckDBAccessMode;
  persistenceError: string | null;
  dataSourceVersions: Map<string, string>;
  activeLoads: Map<string, Promise<void>>;
  mosaic: MosaicInstance | null;
}

const sessions = new Map<string, DashboardSessionHandle>();
const pendingCreations = new Map<string, Promise<DashboardSessionHandle>>();

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

async function destroyMosaic(session: DashboardSessionHandle): Promise<void> {
  if (!session.mosaic) {
    return;
  }
  try {
    session.mosaic.destroy();
  } catch {
    // Best-effort cleanup when coordinator teardown fails.
  }
  session.mosaic = null;
}

async function createSession(
  dashboardId: string,
  requestedAccessMode: PersistentDuckDBAccessMode = "read-only",
): Promise<DashboardSessionHandle> {
  let db: AsyncDuckDB;
  const opfsAvailable = isOPFSAvailable();
  let persistent = false;
  let accessMode: PersistentDuckDBAccessMode = "read-write";
  let persistenceError: string | null = null;
  let dataSourceVersions = new Map<string, string>();

  console.log(
    `[opfs-diag] Creating session for dashboard=${dashboardId}, OPFS available=${opfsAvailable}, requestedAccessMode=${requestedAccessMode}`,
  );

  if (opfsAvailable) {
    try {
      const path = opfsPath(dashboardId);
      console.log(
        `[opfs-diag] Opening OPFS database at ${path} with accessMode=${requestedAccessMode}`,
      );
      db = await createPersistentDuckDBInstance(path, requestedAccessMode);
      persistent = true;
      accessMode = requestedAccessMode;
      if (requestedAccessMode === "read-write") {
        await initMetadataTable(db);
      }
      dataSourceVersions = await loadPersistedVersions(db);
      console.log(
        `[opfs-diag] OPFS session ready for ${dashboardId}: ` +
          `${dataSourceVersions.size} persisted data source(s), accessMode=${accessMode}`,
      );
      if (dataSourceVersions.size > 0) {
        for (const [dsId, hash] of dataSourceVersions) {
          console.log(
            `[opfs-diag]   persisted: dataSource=${dsId} versionHash=${hash}`,
          );
        }
      }
    } catch (err) {
      persistenceError =
        err instanceof Error ? err.message : "Unknown OPFS open failure";
      console.warn(
        `[opfs-diag] OPFS FAILED for ${dashboardId}, falling back to in-memory:`,
        err,
      );
      db = await createDuckDBInstance();
      accessMode = "read-write";
    }
  } else {
    console.log(
      `[opfs-diag] OPFS not available in this browser, using in-memory for ${dashboardId}`,
    );
    db = await createDuckDBInstance();
    accessMode = "read-write";
  }

  const session: DashboardSessionHandle = {
    dashboardId,
    sessionId: crypto.randomUUID(),
    db,
    opfsAvailable,
    persistent,
    accessMode,
    persistenceError,
    dataSourceVersions,
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
  if (existing) return existing;

  const pending = pendingCreations.get(dashboardId);
  if (pending) return pending;

  const creation = createSession(dashboardId).finally(() => {
    pendingCreations.delete(dashboardId);
  });
  pendingCreations.set(dashboardId, creation);
  return creation;
}

export async function ensureWritableDashboardSession(
  dashboardId: string,
): Promise<DashboardSessionHandle> {
  const session = await ensureDashboardSession(dashboardId);
  if (!session.persistent || session.accessMode === "read-write") {
    return session;
  }

  console.log(
    `[opfs-diag] Promoting dashboard=${dashboardId} session from read-only to read-write`,
  );
  await destroyMosaic(session);
  await (session.db as any).terminate?.();

  const writableSession = await createSession(dashboardId, "read-write");
  session.db = writableSession.db;
  session.opfsAvailable = writableSession.opfsAvailable;
  session.persistent = writableSession.persistent;
  session.accessMode = writableSession.accessMode;
  session.persistenceError = writableSession.persistenceError;
  session.dataSourceVersions = writableSession.dataSourceVersions;
  sessions.set(dashboardId, session);

  console.log(
    `[opfs-diag] Dashboard=${dashboardId} session promotion complete, accessMode=${session.accessMode}, persistent=${session.persistent}`,
  );
  return session;
}

export function getDashboardSession(
  dashboardId: string,
): DashboardSessionHandle | null {
  return sessions.get(dashboardId) || null;
}

export async function checkpointSession(dashboardId: string): Promise<void> {
  const session = sessions.get(dashboardId);
  if (!session?.persistent || session.accessMode !== "read-write") return;
  await checkpointDatabase(session.db);
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
  dashboardId: string,
  dataSourceId: string,
  versionHash: string,
  tableRef: string,
  rowCount: number,
): Promise<void> {
  const session = sessions.get(dashboardId);
  if (!session?.persistent || session.accessMode !== "read-write") return;

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
  if (!session?.persistent || session.accessMode !== "read-write") return;

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

export async function disposeDashboardSession(
  dashboardId: string,
): Promise<void> {
  const session = sessions.get(dashboardId);
  if (!session) {
    return;
  }

  await destroyMosaic(session);
  if (session.persistent && session.accessMode === "read-write") {
    await checkpointDatabase(session.db).catch(() => {});
  }

  pendingCreations.delete(dashboardId);
  sessions.delete(dashboardId);
  await (session.db as any).terminate?.();
}

export async function destroyDashboardStorage(
  dashboardId: string,
): Promise<void> {
  await disposeDashboardSession(dashboardId);
  await deleteOPFSFiles(dashboardId);
}

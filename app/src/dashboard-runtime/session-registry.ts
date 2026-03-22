/* eslint-disable no-console */
import type { AsyncDuckDB } from "@duckdb/duckdb-wasm";
import {
  createDuckDBInstance,
  createPersistentDuckDBInstance,
  checkpointDatabase,
  deleteOPFSFiles,
  isOPFSAvailable,
  terminateTrackedDuckDBInstance,
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
const pendingCreations = new Map<string, Promise<DashboardSessionHandle>>();

const METADATA_TABLE = "_mako_ds_versions";

function opfsPath(dashboardId: string): string {
  return `opfs://mako_dashboard_${dashboardId}.db`;
}

async function logDatabaseState(
  db: AsyncDuckDB,
  dashboardId: string,
): Promise<void> {
  console.log(
    `[opfs-diag] logDatabaseState start for dashboard=${dashboardId}`,
  );
  const conn = await db.connect();
  console.log(
    `[opfs-diag] logDatabaseState connection opened for dashboard=${dashboardId}`,
  );
  try {
    const tablesResult = await conn.query("SHOW TABLES");
    const tables: string[] = [];
    for (let i = 0; i < tablesResult.numRows; i++) {
      tables.push(String(tablesResult.getChild("name")?.get(i)));
    }
    console.log(
      `[opfs-diag] SHOW TABLES for dashboard=${dashboardId}: ${tables.length > 0 ? tables.join(", ") : "(none)"}`,
    );

    try {
      const schemaResult = await conn.query(`DESCRIBE "${METADATA_TABLE}"`);
      const schemaRows: string[] = [];
      for (let i = 0; i < schemaResult.numRows; i++) {
        const columnName = String(schemaResult.getChild("column_name")?.get(i));
        const columnType = String(schemaResult.getChild("column_type")?.get(i));
        schemaRows.push(`${columnName}:${columnType}`);
      }
      console.log(
        `[opfs-diag] DESCRIBE ${METADATA_TABLE} for dashboard=${dashboardId}: ${schemaRows.length > 0 ? schemaRows.join(", ") : "(empty)"}`,
      );
    } catch (error) {
      console.warn(
        `[opfs-diag] DESCRIBE ${METADATA_TABLE} failed for dashboard=${dashboardId}`,
        error,
      );
    }

    try {
      const metadataRows = await conn.query(
        `SELECT data_source_id, version_hash, table_ref, row_count FROM "${METADATA_TABLE}" ORDER BY data_source_id`,
      );
      console.log(
        `[opfs-diag] Metadata rows for dashboard=${dashboardId}: ${metadataRows.numRows}`,
      );
      for (let i = 0; i < metadataRows.numRows; i++) {
        console.log(
          `[opfs-diag] metadata row ${i + 1} for dashboard=${dashboardId}: dataSource=${String(metadataRows.getChild("data_source_id")?.get(i))} version=${String(metadataRows.getChild("version_hash")?.get(i))} tableRef=${String(metadataRows.getChild("table_ref")?.get(i))} rowCount=${String(metadataRows.getChild("row_count")?.get(i))}`,
        );
      }
    } catch (error) {
      console.warn(
        `[opfs-diag] Metadata row query failed for dashboard=${dashboardId}`,
        error,
      );
    }
  } finally {
    await conn.close();
    console.log(
      `[opfs-diag] logDatabaseState connection closed for dashboard=${dashboardId}`,
    );
  }
}

async function initMetadataTable(db: AsyncDuckDB): Promise<void> {
  console.log(`[opfs-diag] initMetadataTable start for ${METADATA_TABLE}`);
  const conn = await db.connect();
  console.log(`[opfs-diag] initMetadataTable connection opened`);
  try {
    await conn.query(
      `CREATE TABLE IF NOT EXISTS "${METADATA_TABLE}" (
        data_source_id VARCHAR PRIMARY KEY,
        version_hash VARCHAR NOT NULL,
        table_ref VARCHAR NOT NULL,
        row_count INTEGER DEFAULT 0
      )`,
    );
    console.log(`[opfs-diag] initMetadataTable success for ${METADATA_TABLE}`);
  } catch (error) {
    console.warn(
      `[opfs-diag] initMetadataTable failed for ${METADATA_TABLE}`,
      error,
    );
    throw error;
  } finally {
    await conn.close();
    console.log(`[opfs-diag] initMetadataTable connection closed`);
  }
}

async function loadPersistedVersions(
  db: AsyncDuckDB,
): Promise<Map<string, string>> {
  const versions = new Map<string, string>();
  console.log(`[opfs-diag] loadPersistedVersions start`);
  const conn = await db.connect();
  console.log(`[opfs-diag] loadPersistedVersions connection opened`);
  try {
    const result = await conn.query(
      `SELECT data_source_id, version_hash FROM "${METADATA_TABLE}"`,
    );
    console.log(
      `[opfs-diag] loadPersistedVersions row count=${result.numRows}`,
    );
    for (let i = 0; i < result.numRows; i++) {
      const dsId = String(result.getChild("data_source_id")?.get(i));
      const hash = String(result.getChild("version_hash")?.get(i));
      console.log(
        `[opfs-diag] loadPersistedVersions row ${i + 1}: dataSource=${dsId} version=${hash}`,
      );
      versions.set(dsId, hash);
    }
  } catch (error) {
    console.warn("[opfs-diag] loadPersistedVersions failed", error);
  } finally {
    await conn.close();
    console.log(`[opfs-diag] loadPersistedVersions connection closed`);
  }
  return versions;
}

async function createSession(
  dashboardId: string,
): Promise<DashboardSessionHandle> {
  let db: AsyncDuckDB;
  let persistent = false;
  let dataSourceVersions = new Map<string, string>();

  console.log(
    `[opfs-diag] Creating session for dashboard=${dashboardId}, OPFS available=${isOPFSAvailable()}`,
  );

  if (isOPFSAvailable()) {
    try {
      const path = opfsPath(dashboardId);
      console.log(`[opfs-diag] Opening OPFS database at ${path}`);
      db = await createPersistentDuckDBInstance(path);
      persistent = true;
      console.log(
        `[opfs-diag] Persistent DuckDB open succeeded for dashboard=${dashboardId}`,
      );
      await initMetadataTable(db);
      console.log(
        `[opfs-diag] Metadata table initialized for dashboard=${dashboardId}`,
      );
      dataSourceVersions = await loadPersistedVersions(db);
      await logDatabaseState(db, dashboardId);
      console.log(
        `[opfs-diag] OPFS session ready for ${dashboardId}: ` +
          `${dataSourceVersions.size} persisted data source(s)`,
      );
      if (dataSourceVersions.size > 0) {
        for (const [dsId, hash] of dataSourceVersions) {
          console.log(
            `[opfs-diag]   persisted: dataSource=${dsId} versionHash=${hash}`,
          );
        }
      }
    } catch (err) {
      const isLockConflict =
        err instanceof Error &&
        (err.message.includes("Access Handle") ||
          err.message.includes("createSyncAccessHandle"));
      console.warn(
        `[opfs-diag] OPFS FAILED for ${dashboardId}${isLockConflict ? " (lock conflict detected)" : ""}, falling back to in-memory:`,
        err,
      );
      db = await createDuckDBInstance();
      console.log(
        `[opfs-diag] In-memory DuckDB created after OPFS failure for dashboard=${dashboardId}`,
      );
    }
  } else {
    console.log(
      `[opfs-diag] OPFS not available in this browser, using in-memory for ${dashboardId}`,
    );
    db = await createDuckDBInstance();
    console.log(
      `[opfs-diag] In-memory DuckDB created because OPFS is unavailable for dashboard=${dashboardId}`,
    );
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

export async function ensureDashboardSession(
  dashboardId: string,
): Promise<DashboardSessionHandle> {
  const existing = sessions.get(dashboardId);
  if (existing) {
    console.log(
      `[opfs-diag] ensureDashboardSession hit existing session for dashboard=${dashboardId}`,
    );
    return existing;
  }

  const pending = pendingCreations.get(dashboardId);
  if (pending) {
    console.log(
      `[opfs-diag] ensureDashboardSession awaiting pending session for dashboard=${dashboardId}`,
    );
    return pending;
  }

  const creation = createSession(dashboardId).finally(() => {
    console.log(
      `[opfs-diag] ensureDashboardSession clearing pending creation for dashboard=${dashboardId}`,
    );
    pendingCreations.delete(dashboardId);
  });
  pendingCreations.set(dashboardId, creation);
  console.log(
    `[opfs-diag] ensureDashboardSession stored pending creation for dashboard=${dashboardId}`,
  );
  return creation;
}

export function getDashboardSession(
  dashboardId: string,
): DashboardSessionHandle | null {
  return sessions.get(dashboardId) || null;
}

export async function checkpointSession(dashboardId: string): Promise<void> {
  const session = sessions.get(dashboardId);
  if (!session?.persistent) {
    console.log(
      `[opfs-diag] checkpointSession skipped for dashboard=${dashboardId} persistent=${Boolean(session?.persistent)}`,
    );
    return;
  }
  console.log(
    `[opfs-diag] checkpointSession start for dashboard=${dashboardId}`,
  );
  await checkpointDatabase(session.db);
  console.log(
    `[opfs-diag] checkpointSession success for dashboard=${dashboardId}`,
  );
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
  if (!session?.persistent) {
    console.log(
      `[opfs-diag] persistDataSourceVersion skipped for dashboard=${dashboardId} dataSource=${dataSourceId} persistent=${Boolean(session?.persistent)}`,
    );
    return;
  }

  console.log(
    `[opfs-diag] persistDataSourceVersion start for dashboard=${dashboardId} dataSource=${dataSourceId} version=${versionHash} tableRef=${tableRef} rowCount=${rowCount}`,
  );
  const conn = await session.db.connect();
  console.log(
    `[opfs-diag] persistDataSourceVersion connection opened for dashboard=${dashboardId} dataSource=${dataSourceId}`,
  );
  try {
    await conn.query(
      `INSERT OR REPLACE INTO "${METADATA_TABLE}"
        (data_source_id, version_hash, table_ref, row_count)
       VALUES ('${dataSourceId}', '${versionHash}', '${tableRef}', ${rowCount})`,
    );
    console.log(
      `[opfs-diag] persistDataSourceVersion write success for dashboard=${dashboardId} dataSource=${dataSourceId}`,
    );
    const verification = await conn.query(
      `SELECT data_source_id, version_hash, table_ref, row_count FROM "${METADATA_TABLE}" WHERE data_source_id = '${dataSourceId}'`,
    );
    console.log(
      `[opfs-diag] persistDataSourceVersion verification row count for dashboard=${dashboardId} dataSource=${dataSourceId}: ${verification.numRows}`,
    );
    if (verification.numRows > 0) {
      console.log(
        `[opfs-diag] persistDataSourceVersion verification row for dashboard=${dashboardId} dataSource=${dataSourceId}: version=${String(verification.getChild("version_hash")?.get(0))} tableRef=${String(verification.getChild("table_ref")?.get(0))} rowCount=${String(verification.getChild("row_count")?.get(0))}`,
      );
    }
  } finally {
    await conn.close();
    console.log(
      `[opfs-diag] persistDataSourceVersion connection closed for dashboard=${dashboardId} dataSource=${dataSourceId}`,
    );
  }
}

export async function removePersistedDataSource(
  dashboardId: string,
  dataSourceId: string,
): Promise<void> {
  const session = sessions.get(dashboardId);
  if (!session?.persistent) {
    console.log(
      `[opfs-diag] removePersistedDataSource skipped for dashboard=${dashboardId} dataSource=${dataSourceId} persistent=${Boolean(session?.persistent)}`,
    );
    return;
  }

  console.log(
    `[opfs-diag] removePersistedDataSource start for dashboard=${dashboardId} dataSource=${dataSourceId}`,
  );
  const conn = await session.db.connect();
  try {
    await conn.query(
      `DELETE FROM "${METADATA_TABLE}" WHERE data_source_id = '${dataSourceId}'`,
    );
    console.log(
      `[opfs-diag] removePersistedDataSource success for dashboard=${dashboardId} dataSource=${dataSourceId}`,
    );
  } catch (error) {
    console.warn(
      `[opfs-diag] removePersistedDataSource failed for dashboard=${dashboardId} dataSource=${dataSourceId}`,
      error,
    );
  } finally {
    await conn.close();
    console.log(
      `[opfs-diag] removePersistedDataSource connection closed for dashboard=${dashboardId} dataSource=${dataSourceId}`,
    );
  }
}

export async function disposeDashboardSession(
  dashboardId: string,
): Promise<void> {
  console.log(
    `[opfs-diag] disposeDashboardSession start for dashboard=${dashboardId}`,
  );
  const session = sessions.get(dashboardId);
  if (!session) {
    console.log(
      `[opfs-diag] disposeDashboardSession no-op; no session for dashboard=${dashboardId}`,
    );
    return;
  }

  if (session.mosaic) {
    try {
      session.mosaic.destroy();
      console.log(
        `[opfs-diag] disposeDashboardSession destroyed mosaic for dashboard=${dashboardId}`,
      );
    } catch {
      // Best-effort cleanup when coordinator teardown fails.
    }
    session.mosaic = null;
  }
  if (session.persistent) {
    console.log(
      `[opfs-diag] disposeDashboardSession checkpointing persistent DB for dashboard=${dashboardId}`,
    );
    await checkpointDatabase(session.db).catch(error => {
      console.warn(
        `[opfs-diag] disposeDashboardSession checkpoint failed for dashboard=${dashboardId}`,
        error,
      );
    });
  }

  pendingCreations.delete(dashboardId);
  sessions.delete(dashboardId);
  await terminateTrackedDuckDBInstance(
    session.db,
    `disposeDashboardSession:${dashboardId}`,
  );
  console.log(
    `[opfs-diag] disposeDashboardSession complete for dashboard=${dashboardId}`,
  );
}

export async function destroyDashboardStorage(
  dashboardId: string,
): Promise<void> {
  await disposeDashboardSession(dashboardId);
  await deleteOPFSFiles(dashboardId);
}

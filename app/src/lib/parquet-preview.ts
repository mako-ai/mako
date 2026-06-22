/**
 * Materialized-data preview: fetch a Parquet artifact (app binding or
 * dashboard data source) and read its first rows through a transient
 * DuckDB-WASM instance. Used by the data source editors to show a snapshot of
 * what was actually materialized — like the table previews in the explorer,
 * but for artifacts.
 */

import {
  createDuckDBInstance,
  loadParquetTable,
  queryDuckDB,
  collectStreamBytes,
  terminateTrackedDuckDBInstance,
  type DuckDBQueryResult,
} from "./duckdb";

export const PARQUET_PREVIEW_ROW_LIMIT = 100;

/**
 * Fetch `artifactUrl` (workspace-scoped serve route) and return the first
 * `limit` rows plus the artifact's total row count.
 */
export async function previewParquetArtifact(
  artifactUrl: string,
  options?: { limit?: number; signal?: AbortSignal },
): Promise<DuckDBQueryResult & { totalRows: number }> {
  const limit = options?.limit ?? PARQUET_PREVIEW_ROW_LIMIT;

  const response = await fetch(artifactUrl, {
    credentials: "include",
    signal: options?.signal,
  });
  if (!response.ok || !response.body) {
    throw new Error("Failed to fetch the materialized artifact");
  }
  const buffer = await collectStreamBytes(response.body);

  const db = await createDuckDBInstance();
  try {
    await loadParquetTable(db, "artifact_preview", buffer);
    const result = await queryDuckDB(
      db,
      `SELECT * FROM "artifact_preview" LIMIT ${limit}`,
    );
    const count = await queryDuckDB(
      db,
      `SELECT count(*)::DOUBLE AS n FROM "artifact_preview"`,
    );
    const totalRows = Number(count.rows[0]?.n ?? result.rowCount);
    return { ...result, totalRows };
  } finally {
    void terminateTrackedDuckDBInstance(db, "parquet-preview").catch(
      () => undefined,
    );
  }
}

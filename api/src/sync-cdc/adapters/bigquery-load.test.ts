import { describe, it, expect } from "vitest";
import { promises as fs } from "fs";
import { DuckDBInstance } from "@duckdb/node-api";
import { buildParquetFromBatches } from "../../utils/streaming-parquet-builder";
import {
  STAGING_SCHEMA_UPDATE_OPTIONS,
  loadParquetToStaging,
} from "./bigquery-load";
import type { BigQueryTarget } from "./bigquery-target";

/**
 * A bulk backfill appends one Parquet file per flush batch to one staging
 * table. DuckDB 2.0 (since #1137, 22 Oct 2026) writes a column with no NULL
 * as REQUIRED, so the first file can create the staging column REQUIRED and
 * BigQuery then rejects a later file with a NULL in it: "Field X has changed
 * mode from REQUIRED to NULLABLE". 4,300+ such load failures hit prod flows
 * between 22 Oct and 17 Nov 2026. The load must allow field relaxation.
 */

async function repetitionTypes(
  filePath: string,
): Promise<Record<string, string>> {
  const instance = await DuckDBInstance.create(":memory:");
  const conn = await instance.connect();
  try {
    const reader = await conn.runAndReadAll(
      `SELECT name, repetition_type FROM parquet_schema('${filePath.replace(/'/g, "''")}')`,
    );
    return Object.fromEntries(
      reader
        .getRowObjects()
        .map(r => [String(r.name), String(r.repetition_type)]),
    );
  } finally {
    conn.closeSync();
    instance.closeSync();
  }
}

describe("CDC staging Parquet loads", () => {
  it("the Parquet builder writes a column with no NULL as REQUIRED (the trigger)", async () => {
    const parquet = await buildParquetFromBatches({
      filenameBase: "bigquery-load-test",
      streamBatches: async insert => {
        await insert([
          { id: "a", dense: "x", sparse: null },
          { id: "b", dense: "y", sparse: "z" },
        ]);
      },
    });
    try {
      const modes = await repetitionTypes(parquet.filePath);
      expect(modes.dense).toBe("REQUIRED");
      expect(modes.sparse).toBe("OPTIONAL");
    } finally {
      await fs.rm(parquet.filePath, { force: true });
    }
  });

  it("appends with ALLOW_FIELD_RELAXATION as well as ALLOW_FIELD_ADDITION", async () => {
    expect(STAGING_SCHEMA_UPDATE_OPTIONS).toEqual([
      "ALLOW_FIELD_ADDITION",
      "ALLOW_FIELD_RELAXATION",
    ]);

    const loads: Array<Record<string, unknown>> = [];
    const bq = {
      dataset: () => ({
        table: () => ({
          load: async (_path: string, metadata: Record<string, unknown>) => {
            loads.push(metadata);
            return [{ statistics: { load: { outputRows: "2" } } }];
          },
        }),
      }),
    };
    const target = {
      bq,
      projectId: "p",
      dataset: "d",
      datasetLocation: "EU",
      destination: { workspaceId: "w" },
    } as unknown as BigQueryTarget;

    const result = await loadParquetToStaging(
      target,
      "/nonexistent.parquet",
      "leads__backfill_staging",
      { skipParquetCleanup: true },
    );

    expect(result).toEqual({ loaded: 2 });
    expect(loads).toHaveLength(1);
    expect(loads[0]).toMatchObject({
      sourceFormat: "PARQUET",
      writeDisposition: "WRITE_APPEND",
      schemaUpdateOptions: ["ALLOW_FIELD_ADDITION", "ALLOW_FIELD_RELAXATION"],
    });
  });
});

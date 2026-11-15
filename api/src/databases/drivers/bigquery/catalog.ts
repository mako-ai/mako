/**
 * Listing what a BigQuery project holds (datasets, tables, columns) for the
 * tree, autocomplete and the agent's discovery tools.
 */
import type { IDatabaseConnection } from "../../../database/workspace-schema";
import { loggers } from "../../../logging";
import {
  bigQueryConfig,
  MISSING_CREDENTIALS,
  type BigQueryEngine,
} from "./engine";
import type { BigQueryField } from "./rows";

const logger = loggers.db("bigquery");

export interface BigQueryTableEntry {
  name: string;
  type: string;
  options: { datasetId: string; tableId: string };
}

interface DatasetsPage {
  datasets?: Array<{ datasetReference?: { datasetId?: string } }>;
  nextPageToken?: string;
}

interface TablesPage {
  tables?: Array<{ type?: string; tableReference?: { tableId?: string } }>;
  nextPageToken?: string;
}

/** Run `work` over `items`, at most `limit` at a time. */
async function forEachLimited<T>(
  items: T[],
  limit: number,
  work: (item: T) => Promise<void>,
): Promise<void> {
  let index = 0;
  const runNext = async () => {
    while (index < items.length) {
      await work(items[index++]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, runNext),
  );
}

// Public: list BigQuery datasets (by datasetId)
export async function listDatasets(
  engine: BigQueryEngine,
  database: IDatabaseConnection,
): Promise<string[]> {
  const { project_id, service_account_json, api_base_url } =
    bigQueryConfig(database);
  if (!project_id || !service_account_json) {
    throw new Error(MISSING_CREDENTIALS);
  }

  const client = await engine.getHttpClient(service_account_json, api_base_url);

  const datasets: string[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, unknown> = { maxResults: 1000 };
    if (pageToken) params.pageToken = pageToken;
    const res = await client.get(`/projects/${project_id}/datasets`, {
      params,
    });
    const data: DatasetsPage = res.data || {};
    const items = Array.isArray(data.datasets) ? data.datasets : [];
    for (const ds of items) {
      const id = ds?.datasetReference?.datasetId;
      if (id) datasets.push(id);
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return datasets.sort((a, b) => a.localeCompare(b));
}

// Public (autocomplete): list BigQuery datasets with prefix/limit and early-stop pagination
export async function listDatasetsForAutocomplete(
  engine: BigQueryEngine,
  database: IDatabaseConnection,
  opts?: { prefix?: string; limit?: number },
): Promise<string[]> {
  const { project_id, service_account_json, api_base_url } =
    bigQueryConfig(database);
  if (!project_id || !service_account_json) {
    throw new Error(MISSING_CREDENTIALS);
  }

  const prefix = String(opts?.prefix || "");
  const limit = Math.max(1, Math.min(200, Number(opts?.limit || 100)));

  const client = await engine.getHttpClient(service_account_json, api_base_url);

  const datasets: string[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, unknown> = { maxResults: 1000 };
    if (pageToken) params.pageToken = pageToken;
    const res = await client.get(`/projects/${project_id}/datasets`, {
      params,
    });
    const data: DatasetsPage = res.data || {};
    const items = Array.isArray(data.datasets) ? data.datasets : [];
    for (const ds of items) {
      const id = ds?.datasetReference?.datasetId;
      if (!id) continue;
      if (prefix && !String(id).startsWith(prefix)) continue;
      datasets.push(String(id));
      if (datasets.length >= limit) {
        return datasets;
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return datasets.sort((a, b) => a.localeCompare(b));
}

// Public: get columns for a single BigQuery table (for incremental autocomplete)
export async function getTableColumns(
  engine: BigQueryEngine,
  database: IDatabaseConnection,
  datasetId: string,
  tableId: string,
): Promise<Array<{ name: string; type: string }>> {
  const { project_id, service_account_json, api_base_url } =
    bigQueryConfig(database);
  if (!project_id || !service_account_json) {
    throw new Error(MISSING_CREDENTIALS);
  }
  if (!datasetId || !tableId) return [];

  const client = await engine.getHttpClient(service_account_json, api_base_url);
  const res = await client.get(
    `/projects/${project_id}/datasets/${encodeURIComponent(
      datasetId,
    )}/tables/${encodeURIComponent(tableId)}`,
  );
  const fields: BigQueryField[] = Array.isArray(res?.data?.schema?.fields)
    ? res.data.schema.fields
    : [];

  const out: Array<{ name: string; type: string }> = [];
  const flatten = (prefix: string, field: BigQueryField) => {
    const name = String(field?.name || "");
    const type = String(field?.type || "");
    if (!name) return;
    const full = prefix ? `${prefix}.${name}` : name;
    out.push({ name: full, type });
    const nested = Array.isArray(field?.fields) ? field.fields : [];
    if (String(type).toUpperCase() === "RECORD" && nested.length > 0) {
      nested.forEach(f => flatten(full, f));
    }
  };
  fields.forEach(f => flatten("", f));
  return out;
}

// Public (autocomplete): list BigQuery tableIds for a dataset with prefix/limit and early-stop
export async function listTableIdsForAutocomplete(
  engine: BigQueryEngine,
  database: IDatabaseConnection,
  datasetId: string,
  opts?: { prefix?: string; limit?: number },
): Promise<string[]> {
  const { project_id, service_account_json, api_base_url } =
    bigQueryConfig(database);
  if (!project_id || !service_account_json) {
    throw new Error(MISSING_CREDENTIALS);
  }
  const prefix = String(opts?.prefix || "");
  const limit = Math.max(1, Math.min(200, Number(opts?.limit || 100)));

  const client = await engine.getHttpClient(service_account_json, api_base_url);
  const out: string[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, unknown> = { maxResults: 1000 };
    if (pageToken) params.pageToken = pageToken;
    const res = await client.get(
      `/projects/${project_id}/datasets/${encodeURIComponent(
        datasetId,
      )}/tables`,
      { params },
    );
    const data: TablesPage = res.data || {};
    const tables = Array.isArray(data.tables) ? data.tables : [];
    for (const t of tables) {
      const tableId = t?.tableReference?.tableId;
      if (!tableId) continue;
      const tid = String(tableId);
      if (prefix && !tid.startsWith(prefix)) continue;
      out.push(tid);
      if (out.length >= limit) {
        return out;
      }
    }
    pageToken = data.nextPageToken;
  } while (pageToken);
  return out.sort((a, b) => a.localeCompare(b));
}

// Public: Get BigQuery schema (tables and columns) for autocomplete
export async function getSchema(
  engine: BigQueryEngine,
  database: IDatabaseConnection,
): Promise<
  Record<string, Record<string, Array<{ name: string; type: string }>>>
> {
  const { project_id } = bigQueryConfig(database);
  if (!project_id) {
    throw new Error("BigQuery requires 'project_id' in connection");
  }

  // List all datasets first
  const datasetIds = await listDatasets(engine, database);

  const schema: Record<
    string,
    Record<string, Array<{ name: string; type: string }>>
  > = {};

  // Fetch schema for each dataset in parallel with concurrency limit
  const fetchDatasetSchema = async (datasetId: string) => {
    try {
      const query = `
          SELECT table_name, column_name, data_type 
          FROM \`${project_id}.${datasetId}.INFORMATION_SCHEMA.COLUMNS\`
          ORDER BY table_name, ordinal_position
        `;

      const result = await engine.executeQuery(database, query, {
        labels: { mako_source: "metadata" },
      });
      if (result.success && Array.isArray(result.data)) {
        if (!schema[datasetId]) schema[datasetId] = {};

        for (const row of result.data as Array<Record<string, string>>) {
          const tableName = row.table_name;
          const colName = row.column_name;
          const colType = row.data_type;

          if (!schema[datasetId][tableName]) {
            schema[datasetId][tableName] = [];
          }
          schema[datasetId][tableName].push({ name: colName, type: colType });
        }
      }
    } catch (e) {
      logger.warn("Failed to fetch schema for dataset", {
        datasetId,
        error: e,
      });
    }
  };

  await forEachLimited(datasetIds, 5, fetchDatasetSchema);

  return schema;
}

// Public: list BigQuery tables in a dataset
export async function listTables(
  engine: BigQueryEngine,
  database: IDatabaseConnection,
  datasetId: string,
): Promise<BigQueryTableEntry[]> {
  const { project_id, service_account_json, api_base_url } =
    bigQueryConfig(database);
  if (!project_id || !service_account_json) {
    throw new Error(MISSING_CREDENTIALS);
  }

  const client = await engine.getHttpClient(service_account_json, api_base_url);

  const out: BigQueryTableEntry[] = [];
  let pageToken: string | undefined;
  do {
    const params: Record<string, unknown> = { maxResults: 1000 };
    if (pageToken) params.pageToken = pageToken;
    const res = await client.get(
      `/projects/${project_id}/datasets/${encodeURIComponent(
        datasetId,
      )}/tables`,
      { params },
    );
    const data: TablesPage = res.data || {};
    const tables = Array.isArray(data.tables) ? data.tables : [];
    for (const t of tables) {
      const tableId = t?.tableReference?.tableId;
      if (!tableId) continue;
      out.push({
        name: `${datasetId}.${tableId}`,
        type: t?.type || "TABLE",
        options: { datasetId, tableId },
      });
    }
    pageToken = data.nextPageToken;
  } while (pageToken);

  return out;
}

// New: list BigQuery datasets and tables via REST (fast, no deprecated auth)
export async function listDatasetsAndTables(
  engine: BigQueryEngine,
  database: IDatabaseConnection,
): Promise<BigQueryTableEntry[]> {
  const datasetIds = await listDatasets(engine, database);

  const results: BigQueryTableEntry[][] = [];
  await forEachLimited(datasetIds, 5, async datasetId => {
    results.push(await listTables(engine, database, datasetId));
  });

  return results.flat();
}

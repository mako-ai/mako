/**
 * BigQuery on @makoai/connector-sdk: `spec`, `check`, `discover` and `read`.
 *
 * A port of the in-process connector in `api/src/connectors/bigquery/`.
 * Nothing runs it in production yet. `fixtures/parity.mjs` runs both
 * against the same recorded BigQuery responses and compares them query by
 * query.
 *
 * ENTITIES are the connection's SQL queries, one per query
 * (`queryEntities` with `source: "connection"`). Each is untyped: rows land
 * as they come, as in-process.
 *
 * CREDENTIAL: the connection's service-account JSON, and nothing else. See
 * `client.ts`.
 *
 * READ STATE mirrors the in-process `FetchState`: `{ pageToken, jobId,
 * jobLocation, schema, totalRows, totalProcessed }`. The first chunk starts
 * the job (`jobs.query`), waits for it (1 s polls, at most 5 minutes) and
 * reads its first page; later pages follow `pageToken` with the job's own
 * location. No incremental: `since` is never applied, as in-process.
 */
import { defineConnector } from "@makoai/connector-sdk";
import type { Context, ReadBatch } from "@makoai/connector-sdk";
import {
  BigQueryClient,
  DEFAULT_API_BASE_URL,
  jobLabels,
  serviceAccount,
} from "./client.ts";

const PAGE_SIZE = 100;
const RATE_LIMIT_DELAY_MS = 200;
const MAX_WAIT_MS = 5 * 60 * 1000;
const POLL_INTERVAL_MS = 1000;

interface BigQueryConfig {
  service_account_json?: string | Record<string, string>;
  project_id?: string;
  location?: string;
  api_base_url?: string;
  queries?: Array<Record<string, unknown>>;
  /** Rows per page, from the engine's batch size; a query's own wins. */
  __page_size?: number;
  __rate_limit_delay_ms?: number;
  /** For the job labels, as in-process sets them. */
  __connection_id?: string;
  __workspace_id?: string;
}

interface SchemaField {
  name: string;
  type: string;
  mode?: string;
  fields?: SchemaField[];
}

type JsonRecord = Record<string, any>;

/** `validateConfig`, as `testConnection` runs it first. */
function configErrors(config: BigQueryConfig): string[] {
  const errors: string[] = [];
  if (!config.project_id) errors.push("BigQuery project_id is required");
  if (!config.service_account_json) {
    errors.push("Service account JSON is required");
  } else if (typeof config.service_account_json === "string") {
    try {
      const sa = JSON.parse(config.service_account_json);
      if (!sa.client_email || !sa.private_key) {
        errors.push(
          "Service account JSON must include client_email and private_key",
        );
      }
    } catch {
      errors.push("Service account JSON must be valid JSON");
    }
  }
  if (!Array.isArray(config.queries) || config.queries.length === 0) {
    errors.push("At least one SQL query must be configured");
  }
  return errors;
}

function client(config: BigQueryConfig): BigQueryClient {
  return new BigQueryClient(
    serviceAccount(config.service_account_json),
    config.api_base_url,
  );
}

// --- Rows: the in-process mapRow / parseCellValue, line for line ---

function mapRow(row: any, fields: SchemaField[]): JsonRecord {
  const obj: JsonRecord = {};
  const cells: any[] = Array.isArray(row?.f) ? row.f : [];
  for (let i = 0; i < fields.length; i++) {
    obj[fields[i].name] = parseCell(cells[i]?.v, fields[i]);
  }
  return obj;
}

function parseCell(value: any, field: SchemaField): any {
  if (value === null || value === undefined) return null;
  if ((field.mode || "").toUpperCase() === "REPEATED") {
    const list: any[] = Array.isArray(value) ? value : [];
    return list.map(v => parseCell(v?.v ?? v, { ...field, mode: undefined }));
  }
  switch ((field.type || "").toUpperCase()) {
    case "RECORD":
      return mapRow(value, field.fields || []);
    case "INTEGER":
    case "INT64":
    case "FLOAT":
    case "FLOAT64":
    case "NUMERIC":
    case "BIGNUMERIC":
      return value === "" ? null : Number(value);
    case "BOOLEAN":
    case "BOOL":
      return value === true || value === "true";
    case "TIMESTAMP": {
      if (value === "") return null;
      // Epoch seconds as a float string ("1.677123456E9") -> ISO with " UTC".
      const num = Number(value);
      if (!isNaN(num)) {
        return new Date(num * 1000)
          .toISOString()
          .replace("T", " ")
          .replace("Z", " UTC");
      }
      return value;
    }
    default:
      return value;
  }
}

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

/** One query's job and pages, as the in-process `fetchEntityChunk`. */
async function* readQuery(
  ctx: Context<BigQueryConfig>,
  raw: JsonRecord,
): AsyncGenerator<ReadBatch> {
  const config = ctx.config;
  const projectId = String(config.project_id);
  const configuredLocation = config.location || undefined;
  const ownBatch = Number(raw.batch_size || raw.batchSize) || undefined;
  const batchSize = Number(ownBatch || Number(config.__page_size) || PAGE_SIZE);
  const legacy = Boolean(raw.use_legacy_sql || raw.useLegacySql);
  const delayValue = Number(config.__rate_limit_delay_ms);
  const delay =
    Number.isFinite(delayValue) && delayValue > 0
      ? delayValue
      : RATE_LIMIT_DELAY_MS;

  const api = client(config);
  const state = ctx.state as JsonRecord;
  let processed = Number(state.totalProcessed ?? 0) || 0;
  let pageToken: string | undefined = state.pageToken || undefined;
  let jobId: string | undefined = state.jobId || undefined;
  let jobLocation: string | undefined = state.jobLocation || configuredLocation;
  let schema: { fields: SchemaField[] } | undefined = state.schema;
  let totalRows: number | undefined = state.totalRows;

  const position = () => ({
    ...(pageToken ? { pageToken } : {}),
    ...(jobId ? { jobId } : {}),
    ...(jobLocation ? { jobLocation } : {}),
    ...(schema ? { schema } : {}),
    ...(totalRows !== undefined ? { totalRows } : {}),
    totalProcessed: processed,
  });

  for (;;) {
    let data: JsonRecord;
    if (!jobId) {
      data = await api.post(`/projects/${projectId}/queries`, {
        query: raw.query,
        useLegacySql: legacy || false,
        maxResults: batchSize,
        ...(configuredLocation ? { location: configuredLocation } : {}),
        labels: jobLabels(
          "flow",
          config.__connection_id,
          config.__workspace_id,
        ),
      });
      jobId = data.jobReference?.jobId || jobId;
      // The job's own location: polls and pages must name it.
      jobLocation = data.jobReference?.location || configuredLocation;
      let waited = 0;
      while (data.jobComplete === false && jobId && waited < MAX_WAIT_MS) {
        await sleep(POLL_INTERVAL_MS);
        waited += POLL_INTERVAL_MS;
        const params: Record<string, string | number> = {
          maxResults: batchSize,
        };
        if (jobLocation) params.location = jobLocation;
        data = await api.get(`/projects/${projectId}/queries/${jobId}`, params);
      }
      if (data.jobComplete === false) {
        throw new Error(
          `Query timed out after ${MAX_WAIT_MS / 1000} seconds. The query may still be running in BigQuery.`,
        );
      }
    } else {
      const params: Record<string, string | number> = { maxResults: batchSize };
      if (pageToken) params.pageToken = pageToken;
      if (jobLocation) params.location = jobLocation;
      data = await api.get(`/projects/${projectId}/queries/${jobId}`, params);
    }

    jobId = data.jobReference?.jobId || jobId;
    schema = data.schema || schema;
    if (typeof data.totalRows === "string") totalRows = Number(data.totalRows);
    const rows = Array.isArray(data.rows) ? data.rows : [];
    const mapped = schema
      ? rows.map((row: any) => mapRow(row, schema!.fields))
      : rows;
    processed += mapped.length;
    pageToken = data.pageToken || undefined;
    const hasMore = Boolean(pageToken);
    yield { records: mapped, state: position(), hasMore };
    if (!hasMore) return;
    await sleep(delay);
  }
}

export default defineConnector<BigQueryConfig>({
  name: "bigquery",
  version: "1.0.0",
  title: "BigQuery",
  documentationUrl: "https://cloud.google.com/bigquery/docs/reference/rest",
  config: {
    required: ["service_account_json", "project_id", "queries"],
    properties: {
      service_account_json: {
        type: "string",
        title: "Google Service Account JSON",
        description:
          "Paste the full service account JSON. It will be stored encrypted.",
        airbyte_secret: true,
        multiline: true,
        rows: 10,
        examples: [
          `{
  "type": "service_account",
  "project_id": "your-project",
  "private_key_id": "...",
  "private_key": "-----BEGIN PRIVATE KEY-----\\n...\\n-----END PRIVATE KEY-----\\n",
  "client_email": "svc@project.iam.gserviceaccount.com",
  "token_uri": "https://oauth2.googleapis.com/token"
}`,
        ],
        order: 0,
      },
      project_id: { type: "string", title: "Project ID", order: 1 },
      location: {
        type: "string",
        title: "Location (optional)",
        examples: ["US"],
        order: 2,
      },
      api_base_url: {
        type: "string",
        title: "API Base URL",
        default: DEFAULT_API_BASE_URL,
        order: 3,
      },
      queries: {
        type: "array",
        title: "SQL Queries",
        order: 4,
        items: {
          type: "object",
          required: ["name", "query"],
          properties: {
            name: {
              type: "string",
              title: "Entity Name",
              description: "Name used as entity and collection name",
              examples: ["events_7d"],
            },
            query: {
              type: "string",
              title: "SQL Query",
              multiline: true,
              rows: 12,
              examples: [
                "SELECT * FROM `project.dataset.table` WHERE _PARTITIONTIME > TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL 7 DAY)",
              ],
            },
            use_legacy_sql: {
              type: "boolean",
              title: "Use Legacy SQL",
              default: false,
            },
            batch_size: {
              type: "number",
              title: "Batch Size (maxResults)",
              default: 1000,
            },
          },
        },
      },
    },
  },

  /** The in-process `testConnection`: config checks, then `SELECT 1`. */
  async check(ctx) {
    const config = ctx.config;
    const errors = configErrors(config);
    if (errors.length > 0) {
      throw new Error(`Invalid configuration: ${errors.join("; ")}`);
    }
    await client(config).post(`/projects/${config.project_id}/queries`, {
      query: "SELECT 1 AS one",
      useLegacySql: false,
      maxResults: 1,
      ...(config.location ? { location: config.location } : {}),
      labels: jobLabels(
        "connection_test",
        config.__connection_id,
        config.__workspace_id,
      ),
    });
    return true;
  },

  queryEntities: {
    source: "connection",
    entity: query => ({
      untyped: true,
      read: ctx => readQuery(ctx as Context<BigQueryConfig>, query),
    }),
  },
});

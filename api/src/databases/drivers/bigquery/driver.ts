import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
  ColumnDefinition,
  BatchWriteResult,
  InsertOptions,
  UpsertOptions,
  StreamingQueryOptions,
  TablePartitioning,
  TableClustering,
  WarehouseRelation,
  JobHistoryQueryKind,
  JobHistoryQueryParams,
  JobHistoryRegion,
  JOB_HISTORY_MAX_DAYS,
  JOB_HISTORY_MAX_LIMIT,
  JOB_HISTORY_DEFAULT_LIMIT,
  JOB_HISTORY_MAX_IDS,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import {
  bigQueryGrantTarget,
  bigQueryJobsAccessHint,
  databaseConnectionService,
  isBigQueryJobsAccessDenied,
} from "../../../services/database-connection.service";
import { loggers } from "../../../logging";
import { sanitizeBigQueryLabelValue } from "../../../services/bigquery-labels";
import { BIGQUERY_WORKING_DATASET } from "../../../utils/bigquery-working-dataset";
import { escapeSqlLiteral } from "../../sql-utils";

/**
 * Map source database column types to valid BigQuery types so columns are
 * created correctly regardless of the source engine.
 */
function mapToBigQueryType(sourceType: string): string {
  const t = sourceType.toUpperCase();
  if (t === "TEXT" || t.includes("CHAR") || t.includes("CLOB")) return "STRING";
  if (t === "INTEGER" || t === "INT" || t.includes("INT")) return "INT64";
  if (t === "REAL" || t === "FLOAT" || t === "DOUBLE" || t === "NUMERIC") {
    return "FLOAT64";
  }
  if (t === "BLOB") return "BYTES";
  if (t.includes("BOOL")) return "BOOL";
  if (t.includes("TIME") || t.includes("DATE")) return "TIMESTAMP";
  return "STRING"; // Default to STRING for safety
}

/**
 * Map JavaScript types to BigQuery types
 */
function inferBigQueryType(value: unknown): string {
  if (value === null || value === undefined) return "STRING";
  if (typeof value === "boolean") return "BOOL";
  if (typeof value === "number") {
    if (Number.isInteger(value)) {
      return "INT64";
    }
    return "FLOAT64";
  }
  if (typeof value === "bigint") return "INT64";
  if (value instanceof Date) return "TIMESTAMP";
  if (Array.isArray(value)) return "JSON";
  if (typeof value === "object") return "JSON";
  if (typeof value === "string") {
    // Try to detect date strings
    if (/^\d{4}-\d{2}-\d{2}(T|\s)\d{2}:\d{2}:\d{2}/.test(value)) {
      return "TIMESTAMP";
    }
    if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
      return "DATE";
    }
    return "STRING";
  }
  return "STRING";
}

/**
 * Escape a BigQuery identifier (table name, column name)
 */
function escapeIdentifier(name: string): string {
  return `\`${name.replace(/`/g, "\\`")}\``;
}

/**
 * Escape a string for safe embedding inside a BigQuery single-quoted literal.
 * Uses backslash escaping which works in both regular strings and JSON literals.
 * Order matters: backslashes first, then control chars, then single quotes.
 */
function escapeForBigQueryString(str: string): string {
  return str
    .replace(/\\/g, "\\\\")
    .replace(/\n/g, "\\n")
    .replace(/\r/g, "\\r")
    .replace(/\t/g, "\\t")
    .replace(/'/g, "\\'");
}

/**
 * Escape a string for safe embedding inside a BigQuery JSON literal.
 * Uses triple-quoted strings to avoid single-quote escaping issues entirely.
 * Returns the full `JSON '''...'''` expression.
 */
function formatBigQueryJsonLiteral(jsonStr: string): string {
  // Use PARSE_JSON with escaped single-quoted string for maximum safety
  const escaped = escapeForBigQueryString(jsonStr);
  return `PARSE_JSON('${escaped}')`;
}

/**
 * Format a value for BigQuery insertion
 * @param value - The value to format
 * @param targetType - Optional target column type to cast to (e.g., "STRING", "INT64")
 * @param useCast - If true, wrap value in CAST() to ensure consistent types (for STRUCT arrays)
 */
function formatBigQueryValue(
  value: unknown,
  targetType?: string,
  useCast = false,
): string {
  const resolvedTargetType = useCast
    ? targetType || inferBigQueryType(value)
    : targetType;
  const upperType = resolvedTargetType?.toUpperCase();

  // For useCast mode (STRUCT arrays in MERGE/INSERT), NULL must be typed to avoid
  // BigQuery defaulting to INT64 and causing "Array elements of types do not have
  // a common supertype" errors when mixed with other typed values
  if (value === null || value === undefined) {
    if (useCast && upperType) {
      return `CAST(NULL AS ${upperType})`;
    }
    return "NULL";
  }
  const isNumericTarget =
    upperType === "INT64" ||
    upperType === "INTEGER" ||
    upperType === "FLOAT64" ||
    upperType === "FLOAT" ||
    upperType === "NUMERIC" ||
    upperType === "BIGNUMERIC";

  // When useCast is true (for STRUCT arrays in MERGE), we need to ensure ALL values
  // are formatted consistently to avoid "Array elements of types do not have a common supertype"
  // We do this by always formatting as string and casting to target type
  if (useCast && upperType) {
    // First, format the value as a plain string literal
    let stringValue: string;

    if (typeof value === "boolean") {
      stringValue = value ? "true" : "false";
    } else if (value instanceof Date) {
      stringValue = value.toISOString();
    } else if (Array.isArray(value)) {
      if (upperType === "JSON") {
        return formatBigQueryJsonLiteral(JSON.stringify(value));
      }
      // For STRING target, serialize array as JSON string
      stringValue = escapeForBigQueryString(JSON.stringify(value));
    } else if (typeof value === "object") {
      stringValue = escapeForBigQueryString(JSON.stringify(value));
      if (upperType === "JSON") {
        return formatBigQueryJsonLiteral(JSON.stringify(value));
      }
    } else {
      stringValue = escapeForBigQueryString(String(value));
    }

    // Use SAFE_CAST for type conversion to handle mismatched data gracefully
    // This ensures all STRUCTs have consistent schema
    if (isNumericTarget) {
      return `SAFE_CAST('${stringValue}' AS ${upperType})`;
    } else if (upperType === "BOOL" || upperType === "BOOLEAN") {
      // BigQuery SAFE_CAST doesn't handle 'true'/'false' strings well for BOOL
      // Use explicit CASE for boolean conversion
      const lower = stringValue.toLowerCase();
      if (lower === "true" || lower === "1" || lower === "yes") return "TRUE";
      if (lower === "false" || lower === "0" || lower === "no") return "FALSE";
      return `SAFE_CAST('${stringValue}' AS BOOL)`;
    } else if (upperType === "TIMESTAMP" || upperType === "DATETIME") {
      // If the value is a numeric Unix timestamp (seconds or milliseconds),
      // convert to ISO string first since SAFE_CAST can't parse numeric strings
      const numericValue = Number(stringValue);
      if (!isNaN(numericValue) && stringValue.trim() !== "") {
        // Timestamps > 1e12 are in milliseconds, otherwise seconds
        const ms = numericValue > 1e12 ? numericValue : numericValue * 1000;
        const date = new Date(ms);
        if (!isNaN(date.getTime())) {
          stringValue = date.toISOString();
        }
      }
      return `SAFE_CAST('${stringValue}' AS TIMESTAMP)`;
    } else if (upperType === "DATE") {
      // If the value is a numeric Unix timestamp, convert to date string
      const numericValue = Number(stringValue);
      if (!isNaN(numericValue) && stringValue.trim() !== "") {
        const ms = numericValue > 1e12 ? numericValue : numericValue * 1000;
        const date = new Date(ms);
        if (!isNaN(date.getTime())) {
          stringValue = date.toISOString();
        }
      }
      return `SAFE_CAST('${stringValue.slice(0, 10)}' AS DATE)`;
    } else if (upperType === "STRING") {
      return `CAST('${stringValue}' AS STRING)`;
    } else {
      return `SAFE_CAST('${stringValue}' AS ${upperType})`;
    }
  }

  // Non-CAST mode (for VALUES clause in INSERT, which handles types per-row)
  // Handle numbers: ONLY unquote if we have EXPLICIT numeric target type
  // When targetType is undefined/unknown, ALWAYS quote (safer default)
  if (typeof value === "number" || typeof value === "bigint") {
    // Only output unquoted number if we're 100% sure target is numeric
    if (targetType && isNumericTarget) {
      return String(value);
    }
    // For STRING, unknown, or ANY other case: quote the number
    return `'${String(value)}'`;
  }

  // Handle booleans
  if (typeof value === "boolean") {
    if (upperType === "BOOL" || upperType === "BOOLEAN") {
      return value ? "TRUE" : "FALSE";
    }
    // For STRING or unknown, quote it
    return value ? "'true'" : "'false'";
  }

  // Handle dates
  if (value instanceof Date) {
    if (upperType === "DATE") {
      return `DATE '${value.toISOString().slice(0, 10)}'`;
    }
    if (upperType === "TIMESTAMP" || upperType === "DATETIME" || !upperType) {
      return `TIMESTAMP '${value.toISOString()}'`;
    }
    // For STRING target, quote the ISO string
    return `'${value.toISOString()}'`;
  }

  // Handle arrays — serialize as JSON string so BigQuery creates/matches STRING columns
  if (Array.isArray(value)) {
    if (upperType === "JSON") {
      return formatBigQueryJsonLiteral(JSON.stringify(value));
    }
    const jsonStr = escapeForBigQueryString(JSON.stringify(value));
    return `'${jsonStr}'`;
  }

  // Handle objects (JSON)
  if (typeof value === "object") {
    const jsonStr = escapeForBigQueryString(JSON.stringify(value));
    if (upperType === "JSON") {
      return formatBigQueryJsonLiteral(JSON.stringify(value));
    }
    // For STRING or unknown, just quote the JSON string
    return `'${jsonStr}'`;
  }

  // Handle strings
  const strVal = String(value);
  const escapedStr = escapeForBigQueryString(strVal);

  // If target is TIMESTAMP, wrap with TIMESTAMP keyword
  if (upperType === "TIMESTAMP" || upperType === "DATETIME") {
    return `TIMESTAMP '${escapedStr}'`;
  }

  // If target is DATE, extract date part and wrap
  if (upperType === "DATE") {
    return `DATE '${escapedStr.slice(0, 10)}'`;
  }

  // If target is numeric, try to parse string as number
  if (isNumericTarget) {
    const parsed = parseFloat(strVal);
    if (!isNaN(parsed)) return String(parsed);
  }

  // If target is BOOL, try to parse string as boolean
  if (upperType === "BOOL" || upperType === "BOOLEAN") {
    const lower = strVal.toLowerCase();
    if (lower === "true" || lower === "1") return "TRUE";
    if (lower === "false" || lower === "0") return "FALSE";
  }

  // Default: quoted string
  return `'${escapedStr}'`;
}

// ── Job history and relation listing (read-only introspection) ──────────
//
// The REST path sends no query parameters, so every value that reaches these
// queries is either an integer checked against its bounds or a name checked
// against one of the patterns below. Anything else throws before SQL exists.
//
// A checked name only ever lands inside backticks, inside a single-quoted
// string or inside a raw-string regex (escaped first). No pattern admits a
// backtick, a quote, a backslash or a control character, so no name can
// close what it sits in.

/**
 * A project id, with the optional domain of a domain-scoped project
 * (`example.com:my-project`). A dot is legal in the domain only.
 */
const SAFE_BQ_PROJECT =
  /^(?:[A-Za-z0-9][A-Za-z0-9.-]{0,62}:)?[A-Za-z0-9_-]{1,64}$/;
/** A dataset name: letters, digits and underscores. */
const SAFE_BQ_NAME = /^[A-Za-z0-9_]{1,1024}$/;
/**
 * A table name. BigQuery allows Unicode letters, marks and numbers,
 * connectors (`_`), dashes and spaces.
 */
const SAFE_BQ_TABLE = /^[\p{L}\p{M}\p{N}\p{Pc}\p{Pd}\p{Zs}]{1,1024}$/u;
const SAFE_BQ_REGION = /^[a-z0-9-]{1,40}$/;
/** A BigQuery label value: what dbt and Mako both write. */
const SAFE_BQ_LABEL_VALUE = /^[a-z0-9_-]{1,63}$/;
/** A dbt unique_id (`model.project.name`) or a bare model name. */
const SAFE_DBT_NODE = /^[A-Za-z0-9_.-]{1,200}$/;

/** Statements that define or remove a relation: never a read of it. */
const NON_READ_STATEMENT_TYPES = [
  "SCRIPT",
  "CREATE_VIEW",
  "ALTER_VIEW",
  "DROP_VIEW",
  "CREATE_MATERIALIZED_VIEW",
  "ALTER_MATERIALIZED_VIEW",
  "DROP_MATERIALIZED_VIEW",
  "ALTER_TABLE",
  "DROP_TABLE",
  "TRUNCATE_TABLE",
];

/** Where BigQuery runs a job when nothing says otherwise. */
const DEFAULT_BQ_REGION = "us";

/** Most relations one schema listing returns. */
const LIST_RELATIONS_MAX_ROWS = 50_000;

function boundedInteger(
  value: unknown,
  name: string,
  min: number,
  max: number,
): number {
  if (
    typeof value !== "number" ||
    !Number.isInteger(value) ||
    value < min ||
    value > max
  ) {
    throw new RangeError(`${name} must be an integer from ${min} to ${max}`);
  }
  return value;
}

function checkedName(value: unknown, name: string, pattern: RegExp): string {
  if (typeof value !== "string" || !pattern.test(value)) {
    throw new RangeError(`${name} is not a valid identifier`);
  }
  return value;
}

/** A validated list as SQL string literals, or null when empty. */
function labelValueList(values: string[] | undefined, name: string) {
  if (!values || values.length === 0) return null;
  if (values.length > JOB_HISTORY_MAX_IDS) {
    throw new RangeError(
      `${name} holds more than ${JOB_HISTORY_MAX_IDS} values`,
    );
  }
  return values
    .map(value => `'${checkedName(value, name, SAFE_BQ_LABEL_VALUE)}'`)
    .join(", ");
}

/** A literal for an RE2 pattern: every metacharacter escaped. */
function escapeRe2(literal: string): string {
  return literal.replace(/[\\^$.*+?()[\]{}|-]/g, "\\$&");
}

/** A BigQuery location as the `region-<x>` qualifier spells it. */
function regionOf(location: unknown): string | null {
  if (typeof location !== "string" || !location.trim()) return null;
  return location.trim().toLowerCase();
}

function mapBigQueryTableType(raw: unknown): WarehouseRelation["type"] {
  switch (String(raw ?? "").toUpperCase()) {
    case "BASE TABLE":
    case "CLONE":
      return "table";
    case "VIEW":
      return "view";
    case "MATERIALIZED VIEW":
      return "materialized_view";
    case "EXTERNAL":
      return "external";
    default:
      return "other";
  }
}

function finiteNumber(raw: unknown): number | undefined {
  if (raw === null || raw === undefined || raw === "") return undefined;
  const value = Number(raw);
  return Number.isFinite(value) ? value : undefined;
}

export class BigQueryDatabaseDriver implements DatabaseDriver {
  private logger = loggers.db("bigquery");
  private tableColumnTypeCache = new Map<string, Map<string, string>>();

  private getTableCacheKey(
    database: IDatabaseConnection,
    dataset: string,
    tableName: string,
  ): string {
    const projectId = this.getProjectId(database);
    return `${projectId}.${dataset}.${tableName}`;
  }

  private async getCachedTableColumnTypes(
    database: IDatabaseConnection,
    tableName: string,
    dataset: string,
    forceRefresh = false,
  ): Promise<Map<string, string>> {
    const cacheKey = this.getTableCacheKey(database, dataset, tableName);
    if (!forceRefresh) {
      const cached = this.tableColumnTypeCache.get(cacheKey);
      if (cached) {
        return cached;
      }
    }

    const fetched = await this.getTableColumnTypes(
      database,
      tableName,
      dataset,
    );
    if (fetched.size > 0) {
      this.tableColumnTypeCache.set(cacheKey, fetched);
      return fetched;
    }

    // Avoid caching empty results so transient metadata lookup failures can recover.
    return this.tableColumnTypeCache.get(cacheKey) || fetched;
  }

  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "bigquery",
      displayName: "BigQuery",
      consoleLanguage: "sql",
    } as any;
  }

  async getTreeRoot(
    database: IDatabaseConnection,
  ): Promise<DatabaseTreeNode[]> {
    const datasets =
      await databaseConnectionService.listBigQueryDatasets(database);
    return datasets.map<DatabaseTreeNode>(ds => ({
      id: ds,
      label: ds,
      kind: "dataset",
      hasChildren: true,
      metadata: { datasetId: ds },
    }));
  }

  async getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    if (parent.kind !== "dataset") return [];
    const datasetId = parent.metadata?.datasetId || parent.id;
    const items = await databaseConnectionService.listBigQueryTables(
      database,
      datasetId,
    );
    const groups: Record<string, true> = {};
    for (const it of items) {
      const [, tableIdRaw] = it.name.split(".");
      const base = (tableIdRaw || "").replace(/_(\d{8})$/, "_");
      groups[base] = true;
    }
    return Object.keys(groups)
      .sort((a, b) => a.localeCompare(b))
      .map<DatabaseTreeNode>(base => ({
        id: `${datasetId}.${base}`,
        label: base,
        kind: "table",
        hasChildren: false,
        metadata: { datasetId, tableGroup: base },
      }));
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: string,
    options?: any,
  ) {
    return databaseConnectionService.executeQuery(database, query, options);
  }

  async getAutocompleteData(
    database: IDatabaseConnection,
  ): Promise<Record<string, any>> {
    return databaseConnectionService.getBigQuerySchema(database);
  }

  // ============ DESTINATION DIALECT CAPABILITIES ============

  getStagingSchema(): string {
    // BigQuery isolates staging/working tables in a dedicated dataset so they
    // never pollute the user's live dataset.
    return BIGQUERY_WORKING_DATASET;
  }

  requiresSoftDeleteForCdc(): boolean {
    // The BigQuery CDC MERGE path relies on tombstones for correctness.
    return true;
  }

  requiresTypedColumns(): boolean {
    return true;
  }

  mapColumnType(sourceType: string): string {
    return mapToBigQueryType(sourceType);
  }

  formatTableRef(
    schema: string | undefined,
    table: string,
    options?: { projectId?: string },
  ): string {
    const dataset = options?.projectId
      ? `\`${options.projectId}\`.\`${schema}\``
      : `\`${schema}\``;
    return `${dataset}.${table}`;
  }

  buildRowCountBatchQuery(
    schema: string,
    tableNames: string[],
    options?: { projectId?: string },
  ): string | null {
    if (tableNames.length === 0) return null;
    const inList = tableNames.map(escapeSqlLiteral).join(",");
    const dataset = options?.projectId
      ? `\`${options.projectId}\`.\`${schema}\``
      : `\`${schema}\``;
    return `SELECT table_id, row_count FROM ${dataset}.__TABLES__ WHERE table_id IN (${inList})`;
  }

  /**
   * One bounded query over `INFORMATION_SCHEMA.JOBS_BY_PROJECT` (scope
   * "project", needs `bigquery.jobs.listAll`) or `JOBS_BY_USER` (scope
   * "user", this account's own jobs) in the connection's region. Always
   * filters the `creation_time` partition and always carries a LIMIT.
   */
  buildJobHistoryQuery(
    database: IDatabaseConnection,
    kind: JobHistoryQueryKind,
    params: JobHistoryQueryParams,
  ): string | null {
    const connection = (database.connection ?? {}) as {
      project_id?: unknown;
      location?: unknown;
    };
    const project = checkedName(
      connection.project_id,
      "connection project_id",
      SAFE_BQ_PROJECT,
    );
    // The service passes the region it resolved from the dataset. Without
    // one, the connection's own location, then BigQuery's default.
    const region =
      params.region !== undefined
        ? checkedName(params.region, "region", SAFE_BQ_REGION)
        : checkedName(
            regionOf(connection.location) ?? DEFAULT_BQ_REGION,
            "connection location",
            SAFE_BQ_REGION,
          );
    const days = boundedInteger(params.days, "days", 1, JOB_HISTORY_MAX_DAYS);
    const limit = boundedInteger(
      params.limit ?? JOB_HISTORY_DEFAULT_LIMIT,
      "limit",
      1,
      JOB_HISTORY_MAX_LIMIT,
    );
    if (params.scope !== "project" && params.scope !== "user") {
      throw new RangeError("scope must be project or user");
    }
    const view =
      params.scope === "project" ? "JOBS_BY_PROJECT" : "JOBS_BY_USER";
    const jobs = `\`${project}\`.\`region-${region}\`.INFORMATION_SCHEMA.${view}`;
    const window = `creation_time >= TIMESTAMP_SUB(CURRENT_TIMESTAMP(), INTERVAL ${days} DAY)`;

    if (kind === "model_cost") {
      return this.buildModelCostQuery({ jobs, window, limit, params });
    }
    if (kind === "table_readers") {
      return this.buildTableReadersQuery({
        jobs,
        window,
        limit,
        project,
        relation: params.relation,
      });
    }
    return null;
  }

  /**
   * Job history is per region, and a query against the wrong region returns
   * no rows instead of failing. So the region comes from the dataset the
   * question is about (its metadata, one REST read), then from the
   * connection's `location`. With neither, BigQuery's default is returned
   * and marked "default": the caller must not trust an empty answer.
   */
  async resolveJobHistoryRegion(
    database: IDatabaseConnection,
    datasets: Array<{ database?: string; schema: string }>,
    options?: { signal?: AbortSignal },
  ): Promise<JobHistoryRegion> {
    for (const dataset of datasets) {
      if (!SAFE_BQ_NAME.test(dataset.schema)) continue;
      if (
        dataset.database !== undefined &&
        !SAFE_BQ_PROJECT.test(dataset.database)
      ) {
        continue;
      }
      let location: string | null = null;
      try {
        location = await databaseConnectionService.getBigQueryDatasetLocation(
          database,
          dataset.schema,
          { projectId: dataset.database, signal: options?.signal },
        );
      } catch (error) {
        if (options?.signal?.aborted) throw error;
        // Unreadable metadata is not a region: try the next source.
        this.logger.warn("Could not read a BigQuery dataset location", {
          dataset: dataset.schema,
          error: error instanceof Error ? error.message : String(error),
        });
      }
      const region = regionOf(location);
      if (region && SAFE_BQ_REGION.test(region)) {
        return { region, source: "dataset" };
      }
    }
    const configured = regionOf(
      (database.connection as { location?: unknown } | undefined)?.location,
    );
    if (configured && SAFE_BQ_REGION.test(configured)) {
      return { region: configured, source: "connection" };
    }
    return { region: DEFAULT_BQ_REGION, source: "default" };
  }

  isJobHistoryAccessDenied(error: string): boolean {
    return isBigQueryJobsAccessDenied(error);
  }

  describeJobHistoryGrant(database: IDatabaseConnection): string {
    return bigQueryJobsAccessHint(bigQueryGrantTarget(database));
  }

  private buildModelCostQuery(input: {
    jobs: string;
    window: string;
    limit: number;
    params: JobHistoryQueryParams;
  }): string {
    const { jobs, window, limit, params } = input;
    const invocations = labelValueList(params.invocationIds, "invocationIds");
    const runs = labelValueList(params.makoRunIds, "makoRunIds");
    const labelMatches = [
      invocations &&
        `(l.key = 'dbt_invocation_id' AND l.value IN (${invocations}))`,
      runs && `(l.key = 'mako_dbt_run' AND l.value IN (${runs}))`,
    ].filter((clause): clause is string => Boolean(clause));
    if (labelMatches.length === 0) {
      // Without a run set the query would price every job of the project.
      throw new RangeError("model_cost needs invocationIds or makoRunIds");
    }

    let modelFilter = "";
    if (params.model !== undefined) {
      const model = checkedName(params.model, "model", SAFE_DBT_NODE);
      modelFilter =
        `\n  WHERE node_id = '${model}'` +
        `\n    OR ENDS_WITH(node_id, '.${model}')` +
        `\n    OR node_id = '${sanitizeBigQueryLabelValue(model)}'`;
    }

    // Script children repeat their parent's cost, so only top-level jobs are
    // summed. The node id comes from dbt's query comment, else its job label.
    // The totals are window sums over every group, taken before LIMIT cuts
    // the list, so they hold for the whole window whatever the row cap.
    return `WITH dbt_jobs AS (
  SELECT
    DATE(creation_time) AS day,
    COALESCE(
      REGEXP_EXTRACT(query, r'"node_id":\\s*"([^"]+)"'),
      (SELECT l.value FROM UNNEST(labels) AS l WHERE l.key = 'node_id' LIMIT 1)
    ) AS node_id,
    IF(
      destination_table.dataset_id IS NOT NULL
        AND NOT STARTS_WITH(destination_table.dataset_id, '_'),
      CONCAT(destination_table.project_id, '.', destination_table.dataset_id, '.', destination_table.table_id),
      NULL
    ) AS relation,
    (SELECT l.value FROM UNNEST(labels) AS l WHERE l.key = 'dbt_invocation_id' LIMIT 1) AS invocation_id,
    total_bytes_billed,
    total_slot_ms,
    TIMESTAMP_DIFF(end_time, start_time, MILLISECOND) AS duration_ms
  FROM ${jobs}
  WHERE ${window}
    AND job_type = 'QUERY'
    AND parent_job_id IS NULL
    AND EXISTS (
      SELECT 1 FROM UNNEST(labels) AS l
      WHERE ${labelMatches.join("\n        OR ")}
    )
),
per_model_day AS (
  SELECT
    day,
    node_id,
    MAX(relation) AS relation,
    COUNT(*) AS jobs,
    IFNULL(SUM(total_bytes_billed), 0) AS bytes_billed,
    IFNULL(SUM(total_slot_ms), 0) AS slot_ms,
    COUNT(DISTINCT invocation_id) AS invocations,
    CAST(ROUND(AVG(duration_ms)) AS INT64) AS avg_duration_ms
  FROM dbt_jobs${modelFilter}
  GROUP BY day, node_id
)
SELECT
  day,
  node_id,
  relation,
  jobs,
  bytes_billed,
  slot_ms,
  invocations,
  avg_duration_ms,
  COUNT(*) OVER () AS total_rows,
  SUM(jobs) OVER () AS total_jobs,
  SUM(bytes_billed) OVER () AS total_bytes_billed,
  SUM(slot_ms) OVER () AS total_slot_ms
FROM per_model_day
ORDER BY bytes_billed DESC, slot_ms DESC, day DESC, node_id
LIMIT ${limit}`;
  }

  private buildTableReadersQuery(input: {
    jobs: string;
    window: string;
    limit: number;
    project: string;
    relation: JobHistoryQueryParams["relation"];
  }): string {
    const { jobs, window, limit } = input;
    if (!input.relation) {
      throw new RangeError("table_readers needs a relation");
    }
    const project = checkedName(
      input.relation.database ?? input.project,
      "relation database",
      SAFE_BQ_PROJECT,
    );
    const dataset = checkedName(
      input.relation.schema,
      "relation schema",
      SAFE_BQ_NAME,
    );
    const table = checkedName(
      input.relation.name,
      "relation name",
      SAFE_BQ_TABLE,
    );
    // The table name is text inside a regex below: a dash must not read as
    // a range, whatever else the table pattern admits later.
    const tablePattern = escapeRe2(table);
    const isRelation = (alias: string) =>
      `${alias}.project_id = '${project}' AND ${alias}.dataset_id = '${dataset}' AND ${alias}.table_id = '${table}'`;
    const excluded = NON_READ_STATEMENT_TYPES.map(type => `'${type}'`).join(
      ", ",
    );

    // A view never appears in referenced_tables (BigQuery lists the tables
    // under it), so its readers are found in the query text. STRPOS on the
    // bare name runs first: the regex only sees rows that can match.
    return `WITH reads AS (
  SELECT
    user_email,
    (SELECT l.value FROM UNNEST(labels) AS l WHERE l.key = 'mako_source' LIMIT 1) AS mako_source,
    (SELECT l.value FROM UNNEST(labels) AS l WHERE l.key = 'mako_app' LIMIT 1) AS mako_app,
    total_bytes_billed,
    creation_time,
    EXISTS (
      SELECT 1 FROM UNNEST(referenced_tables) AS r
      WHERE ${isRelation("r")}
    ) AS by_reference
  FROM ${jobs}
  WHERE ${window}
    AND job_type = 'QUERY'
    AND (statement_type IS NULL OR statement_type NOT IN (${excluded}))
    AND NOT IFNULL(${isRelation("destination_table")}, FALSE)
    AND (
      EXISTS (
        SELECT 1 FROM UNNEST(referenced_tables) AS r
        WHERE ${isRelation("r")}
      )
      OR (
        STRPOS(query, '${table}') > 0
        AND REGEXP_CONTAINS(query, r'(?i)(^|[^a-z0-9_])\`?${dataset}\`?\\s*\\.\\s*\`?${tablePattern}\`?([^a-z0-9_]|$)')
      )
    )
    AND NOT IFNULL(REGEXP_CONTAINS(query, r'(?i)information_schema|__tables__'), FALSE)
    AND NOT EXISTS (
      SELECT 1 FROM UNNEST(labels) AS l
      WHERE l.key = 'mako_source' AND l.value = 'metadata'
    )
)
SELECT
  mako_source,
  mako_app,
  user_email,
  COUNT(*) AS jobs,
  IFNULL(SUM(total_bytes_billed), 0) AS bytes_billed,
  FORMAT_TIMESTAMP('%Y-%m-%dT%H:%M:%SZ', MAX(creation_time)) AS last_read_at,
  COUNTIF(NOT by_reference) AS jobs_by_text_only
FROM reads
GROUP BY mako_source, mako_app, user_email
ORDER BY jobs DESC, last_read_at DESC
LIMIT ${limit}`;
  }

  /**
   * Every table and view of one dataset: `INFORMATION_SCHEMA.TABLES` (views
   * included) joined to `__TABLES__` for size, rows and last write. Null
   * when the dataset does not exist.
   */
  async listRelations(
    database: IDatabaseConnection,
    schema: string,
    options?: { projectId?: string; signal?: AbortSignal },
  ): Promise<WarehouseRelation[] | null> {
    const project = checkedName(
      options?.projectId ?? this.getProjectId(database),
      "project",
      SAFE_BQ_PROJECT,
    );
    const dataset = checkedName(schema, "schema", SAFE_BQ_NAME);
    const qualified = `${project}.${dataset}`;
    const result = await this.executeQuery(
      database,
      `SELECT t.table_name, t.table_type, s.size_bytes, s.row_count, s.last_modified_time ` +
        `FROM \`${qualified}\`.INFORMATION_SCHEMA.TABLES AS t ` +
        `LEFT JOIN \`${qualified}.__TABLES__\` AS s ON s.table_id = t.table_name ` +
        `ORDER BY t.table_name LIMIT ${LIST_RELATIONS_MAX_ROWS}`,
      {
        readOnly: true,
        labels: { mako_source: "metadata" },
        ...(options?.signal ? { signal: options.signal } : {}),
      },
    );
    if (!result.success) {
      // A stopped caller is not a missing dataset and not a warehouse fault.
      options?.signal?.throwIfAborted();
      if (/not found: dataset/i.test(result.error ?? "")) return null;
      throw new Error(
        `Could not list relations of ${qualified}: ${result.error ?? "unknown error"}`,
      );
    }
    const rows = Array.isArray(result.data) ? result.data : [];
    const relations: WarehouseRelation[] = [];
    for (const row of rows as Array<Record<string, unknown>>) {
      if (typeof row.table_name !== "string") continue;
      const type = mapBigQueryTableType(row.table_type);
      const stored = type === "table" || type === "materialized_view";
      const modified = finiteNumber(row.last_modified_time);
      relations.push({
        database: project,
        schema: dataset,
        name: row.table_name,
        type,
        // Views and external tables report 0 here: not a real measure.
        sizeBytes: stored ? finiteNumber(row.size_bytes) : undefined,
        rowCount: stored ? finiteNumber(row.row_count) : undefined,
        lastModified: modified !== undefined ? new Date(modified) : undefined,
      });
    }
    return relations;
  }

  // ============ WRITE CAPABILITIES ============

  supportsWrites(): boolean {
    return true;
  }

  /**
   * Ensure the BigQuery dataset exists, creating it if not.
   */
  async ensureSchema(
    database: IDatabaseConnection,
    schemaName: string,
    options?: { location?: string },
  ): Promise<{ success: boolean; created?: boolean; error?: string }> {
    const projectId = this.getProjectId(database);
    const location =
      options?.location || (database.connection as any).location || "US";

    const checkQuery = `
      SELECT schema_name, location
      FROM ${escapeIdentifier(projectId)}.INFORMATION_SCHEMA.SCHEMATA
      WHERE schema_name = '${schemaName.replace(/'/g, "''")}'
    `;
    const checkResult = await this.executeQuery(database, checkQuery);
    if (
      checkResult.success &&
      checkResult.data &&
      checkResult.data.length > 0
    ) {
      const existingLocationRaw = String(checkResult.data[0]?.location || "")
        .trim()
        .toLowerCase();
      const requestedLocationRaw = String(location || "")
        .trim()
        .toLowerCase();
      if (
        existingLocationRaw &&
        requestedLocationRaw &&
        existingLocationRaw !== requestedLocationRaw
      ) {
        return {
          success: false,
          error: `Dataset ${schemaName} exists in location ${checkResult.data[0]?.location}, but connection is configured for ${location}.`,
        };
      }
      return { success: true, created: false };
    }

    const createQuery = `CREATE SCHEMA IF NOT EXISTS ${escapeIdentifier(projectId)}.${escapeIdentifier(schemaName)} OPTIONS(location='${location}')`;
    const createResult = await this.executeQuery(database, createQuery);
    if (!createResult.success) {
      return { success: false, error: createResult.error };
    }
    return { success: true, created: true };
  }

  /**
   * Get the project ID from the database connection
   */
  private getProjectId(database: IDatabaseConnection): string {
    const conn = database.connection as any;
    return conn.project_id;
  }

  /**
   * Get the schema (column types) for a query using BigQuery's dry run feature.
   * This is more reliable than inferring from sample data because:
   * - NULL values are handled correctly
   * - No data sampling variance
   * - Works even if query returns 0 rows
   */
  async getQuerySchema(
    database: IDatabaseConnection,
    query: string,
    _options?: { databaseName?: string },
  ): Promise<{
    success: boolean;
    columns?: ColumnDefinition[];
    error?: string;
  }> {
    const result = await databaseConnectionService.getBigQueryQuerySchema(
      database,
      query,
    );

    if (!result.success || !result.columns) {
      return { success: false, error: result.error };
    }

    // Map to ColumnDefinition format
    const columns: ColumnDefinition[] = result.columns.map(col => ({
      name: col.name,
      type: col.type,
      nullable: col.nullable,
    }));

    return { success: true, columns };
  }

  /**
   * Infer column definitions from sample data
   * @deprecated Prefer getQuerySchema() which is more reliable
   */
  inferSchema(rows: Record<string, unknown>[]): ColumnDefinition[] {
    if (rows.length === 0) return [];

    const columnTypes: Map<string, Set<string>> = new Map();
    const columnNullable: Map<string, boolean> = new Map();

    // Analyze all rows to determine column types
    for (const row of rows) {
      for (const [key, value] of Object.entries(row)) {
        if (!columnTypes.has(key)) {
          columnTypes.set(key, new Set());
          columnNullable.set(key, false);
        }

        if (value === null || value === undefined) {
          columnNullable.set(key, true);
        } else {
          const existing = columnTypes.get(key);
          if (existing) existing.add(inferBigQueryType(value));
        }
      }
    }

    // Build column definitions
    const columns: ColumnDefinition[] = [];
    for (const [name, types] of columnTypes) {
      // If multiple types detected, use STRING as fallback
      let type = "STRING";
      const typeArray = Array.from(types);
      if (typeArray.length === 1) {
        type = typeArray[0];
      } else if (typeArray.length > 1) {
        // Try to find a common numeric type
        if (typeArray.every(t => ["INT64", "FLOAT64"].includes(t))) {
          type = "FLOAT64";
        }
      }

      columns.push({
        name,
        type,
        nullable: columnNullable.get(name) ?? true,
      });
    }

    return columns;
  }

  /**
   * Build PARTITION BY clause from config
   */
  private buildPartitionClause(partitioning?: TablePartitioning): string {
    if (!partitioning) return "";
    if (partitioning.type === "ingestion") {
      return "\nPARTITION BY _PARTITIONDATE";
    }
    const field = partitioning.field || "_syncedAt";
    const gran = (partitioning.granularity || "day").toUpperCase();
    return `\nPARTITION BY TIMESTAMP_TRUNC(${escapeIdentifier(field)}, ${gran})`;
  }

  /**
   * Build CLUSTER BY clause from config
   */
  private buildClusterClause(clustering?: TableClustering): string {
    if (!clustering || clustering.fields.length === 0) return "";
    const cols = clustering.fields.slice(0, 4).map(escapeIdentifier).join(", ");
    return `\nCLUSTER BY ${cols}`;
  }

  /**
   * Build OPTIONS clause for partition filter requirement
   */
  private buildTableOptions(partitioning?: TablePartitioning): string {
    if (!partitioning?.requirePartitionFilter) return "";
    return `\nOPTIONS (require_partition_filter = TRUE)`;
  }

  /**
   * Create a table with the given schema
   * In BigQuery, schema = dataset
   * Supports partition/cluster/soft-delete column injection via InsertOptions
   */
  async createTable(
    database: IDatabaseConnection,
    tableName: string,
    columns: ColumnDefinition[],
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    if (!dataset) {
      return {
        success: false,
        error: "Dataset (schema) is required for BigQuery",
      };
    }

    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;

    const allColumns = [...columns];

    if (options?.softDeleteColumns) {
      const existingNames = new Set(allColumns.map(c => c.name.toLowerCase()));
      if (
        !existingNames.has(options.softDeleteColumns.isDeleted.toLowerCase())
      ) {
        allColumns.push({
          name: options.softDeleteColumns.isDeleted,
          type: "BOOL",
          nullable: true,
        });
      }
      if (
        !existingNames.has(options.softDeleteColumns.deletedAt.toLowerCase())
      ) {
        allColumns.push({
          name: options.softDeleteColumns.deletedAt,
          type: "TIMESTAMP",
          nullable: true,
        });
      }
    }

    const columnDefs = allColumns.map(col => {
      let def = `${escapeIdentifier(col.name)} ${col.type}`;
      if (!col.nullable) def += " NOT NULL";
      return def;
    });

    const partitionClause = this.buildPartitionClause(options?.partitioning);
    const clusterClause = this.buildClusterClause(options?.clustering);
    const tableOptions = this.buildTableOptions(options?.partitioning);

    const query = `CREATE TABLE IF NOT EXISTS ${fullTableName} (\n  ${columnDefs.join(",\n  ")}\n)${partitionClause}${clusterClause}${tableOptions};`;

    const result = await this.executeQuery(database, query);

    return {
      success: result.success,
      error: result.error,
    };
  }

  /**
   * Check if a table exists
   */
  async tableExists(
    database: IDatabaseConnection,
    tableName: string,
    options?: InsertOptions,
  ): Promise<boolean> {
    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    if (!dataset) return false;

    const query = `
      SELECT COUNT(*) as cnt
      FROM ${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.INFORMATION_SCHEMA.TABLES
      WHERE table_name = '${tableName.replace(/'/g, "''")}'
    `;

    const result = await this.executeQuery(database, query);
    if (!result.success || !result.data) return false;
    return (result.data[0]?.cnt ?? 0) > 0;
  }

  /**
   * Get column types for an existing table from INFORMATION_SCHEMA
   * Returns a map of column name -> BigQuery data type
   */
  private async getTableColumnTypes(
    database: IDatabaseConnection,
    tableName: string,
    dataset: string,
  ): Promise<Map<string, string>> {
    const projectId = this.getProjectId(database);
    const columnTypes = new Map<string, string>();

    const query = `
      SELECT column_name, data_type
      FROM ${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.INFORMATION_SCHEMA.COLUMNS
      WHERE table_name = '${tableName.replace(/'/g, "''")}'
    `;

    const result = await this.executeQuery(database, query);
    if (result.success && result.data) {
      for (const row of result.data) {
        if (row.column_name && row.data_type) {
          // Store with lowercase key for case-insensitive lookup
          columnTypes.set(row.column_name.toLowerCase(), row.data_type);
        }
      }
    }

    return columnTypes;
  }

  /**
   * Add missing columns to an existing table via ALTER TABLE ADD COLUMN.
   * Compares row keys against INFORMATION_SCHEMA and adds any that don't exist.
   */
  async addMissingColumns(
    database: IDatabaseConnection,
    tableName: string,
    dataset: string,
    rows: Record<string, unknown>[],
  ): Promise<void> {
    const existingColumns = await this.getCachedTableColumnTypes(
      database,
      tableName,
      dataset,
    );

    const allKeys = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach(k => allKeys.add(k));
    }

    const missing: Array<{ key: string; colType: string }> = [];
    for (const key of allKeys) {
      if (key.includes(".")) continue;
      if (!existingColumns.has(key.toLowerCase())) {
        const sampleValue = rows.find(
          r => r[key] !== null && r[key] !== undefined,
        )?.[key];
        missing.push({ key, colType: inferBigQueryType(sampleValue) });
      }
    }

    if (missing.length === 0) return;

    const projectId = this.getProjectId(database);
    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;
    const maxRetries = Math.max(
      parseInt(process.env.BIGQUERY_SCHEMA_UPDATE_MAX_RETRIES || "8", 10) || 8,
      1,
    );
    const baseDelayMs = Math.max(
      parseInt(
        process.env.BIGQUERY_SCHEMA_UPDATE_RETRY_BASE_MS || "1000",
        10,
      ) || 1000,
      200,
    );
    const maxDelayMs = Math.max(
      parseInt(
        process.env.BIGQUERY_SCHEMA_UPDATE_RETRY_MAX_MS || "30000",
        10,
      ) || 30000,
      baseDelayMs,
    );
    const addedColumns: string[] = [];
    const unresolved: Array<{ key: string; error?: string }> = [];

    // Fast path: add all missing columns in one DDL statement.
    // This avoids N round-trips when payloads contain many new fields.
    const batchAlterQuery = `ALTER TABLE ${fullTableName} ${missing
      .map(
        ({ key, colType }) =>
          `ADD COLUMN IF NOT EXISTS ${escapeIdentifier(key)} ${colType}`,
      )
      .join(", ")}`;
    const batchResult = await this.executeQuery(database, batchAlterQuery);
    if (batchResult.success) {
      for (const { key, colType } of missing) {
        existingColumns.set(key.toLowerCase(), colType);
        addedColumns.push(key);
      }
    } else {
      const batchError =
        typeof batchResult.error === "string"
          ? batchResult.error
          : JSON.stringify(batchResult.error);

      if (this.isSchemaContainerMissingError(batchError)) {
        throw new Error(
          `BIGQUERY_SCHEMA_UPDATE_FAILED: Unable to add ${missing.length} columns for ${dataset}.${tableName}. First error: ${batchError}`,
        );
      }

      this.logger.warn("Batched schema update failed; retrying per column", {
        table: tableName,
        missingColumns: missing.length,
        error: batchError,
      });
    }

    if (addedColumns.length === missing.length) {
      this.logger.info("Schema evolution: added columns", {
        table: tableName,
        columns: addedColumns,
        count: addedColumns.length,
      });
      const cacheKey = this.getTableCacheKey(database, dataset, tableName);
      this.tableColumnTypeCache.set(cacheKey, existingColumns);
      return;
    }

    for (const { key, colType } of missing) {
      if (existingColumns.has(key.toLowerCase())) {
        continue;
      }
      let added = false;
      let lastError: string | undefined;

      for (let attempt = 0; attempt < maxRetries; attempt++) {
        const query = `ALTER TABLE ${fullTableName} ADD COLUMN IF NOT EXISTS ${escapeIdentifier(key)} ${colType}`;
        const result = await this.executeQuery(database, query);
        if (result.success) {
          existingColumns.set(key.toLowerCase(), colType);
          addedColumns.push(key);
          added = true;
          break;
        }

        lastError =
          typeof result.error === "string"
            ? result.error
            : JSON.stringify(result.error);
        if (this.isSchemaContainerMissingError(lastError)) {
          throw new Error(
            `BIGQUERY_SCHEMA_UPDATE_FAILED: Unable to add ${missing.length} columns for ${dataset}.${tableName}. First error: ${lastError}`,
          );
        }
        const quotaExceeded = this.isTableUpdateQuotaExceededError(lastError);
        this.logger.warn("Failed to add column", {
          table: tableName,
          column: key,
          attempt: attempt + 1,
          maxRetries,
          quotaExceeded,
          error: lastError,
        });

        if (quotaExceeded && attempt < maxRetries - 1) {
          const jitter = Math.floor(Math.random() * 250);
          const backoff = Math.min(
            baseDelayMs * 2 ** attempt + jitter,
            maxDelayMs,
          );
          await new Promise(resolve => setTimeout(resolve, backoff));
          continue;
        }

        break;
      }

      if (!added) {
        unresolved.push({ key, error: lastError });
      }
    }

    if (addedColumns.length > 0) {
      this.logger.info("Schema evolution: added columns", {
        table: tableName,
        columns: addedColumns,
        count: addedColumns.length,
      });
    }

    const cacheKey = this.getTableCacheKey(database, dataset, tableName);
    this.tableColumnTypeCache.set(cacheKey, existingColumns);

    if (unresolved.length > 0) {
      const quotaOnly = unresolved.every(entry =>
        this.isTableUpdateQuotaExceededError(entry.error),
      );
      const firstError = unresolved[0]?.error || "unknown";
      const reason = quotaOnly
        ? "BIGQUERY_SCHEMA_UPDATE_QUOTA_EXCEEDED"
        : "BIGQUERY_SCHEMA_UPDATE_FAILED";
      throw new Error(
        `${reason}: Unable to add ${unresolved.length} columns for ${dataset}.${tableName}. First error: ${firstError}`,
      );
    }
  }

  private isTableUpdateQuotaExceededError(error?: string): boolean {
    if (!error) return false;
    const normalized = error.toLowerCase();
    return (
      normalized.includes("table exceeded quota for table update operations") ||
      normalized.includes("job exceeded rate limits") ||
      normalized.includes("rate limit exceeded")
    );
  }

  private isSchemaContainerMissingError(error?: string): boolean {
    if (!error) return false;
    const normalized = error.toLowerCase();
    return (
      normalized.includes("not found: dataset") ||
      normalized.includes("was not found in location")
    );
  }

  private extractRequiredNullField(error?: string): string | undefined {
    if (!error) return undefined;
    // BigQuery pattern: "Required field in_reply_to_id cannot be null"
    const match = error.match(/Required field ([A-Za-z0-9_]+) cannot be null/i);
    return match?.[1];
  }

  private async relaxRequiredColumn(
    database: IDatabaseConnection,
    tableName: string,
    dataset: string,
    columnName: string,
  ): Promise<{ success: boolean; error?: string }> {
    const projectId = this.getProjectId(database);
    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;
    const query = `ALTER TABLE ${fullTableName} ALTER COLUMN ${escapeIdentifier(columnName)} DROP NOT NULL;`;
    const result = await this.executeQuery(database, query);
    return { success: result.success, error: result.error };
  }

  /**
   * Insert a batch of rows into a table using INSERT statement
   * BigQuery has a 1MB query size limit, so we chunk adaptively based on query size
   */
  async insertBatch(
    database: IDatabaseConnection,
    tableName: string,
    rows: Record<string, unknown>[],
    options?: InsertOptions,
  ): Promise<BatchWriteResult> {
    if (rows.length === 0) {
      return { success: true, rowsWritten: 0 };
    }

    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    if (!dataset) {
      return {
        success: false,
        rowsWritten: 0,
        error: "Dataset (schema) is required for BigQuery",
      };
    }

    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;

    // Add any missing columns before writing
    await this.addMissingColumns(database, tableName, dataset, rows);

    // Get column types from INFORMATION_SCHEMA (after adding missing columns)
    let columnTypes = await this.getCachedTableColumnTypes(
      database,
      tableName,
      dataset,
    );

    if (columnTypes.size === 0) {
      this.logger.warn(
        "INFORMATION_SCHEMA returned no column types, forcing refresh",
        {
          table: tableName,
          dataset,
        },
      );
      columnTypes = await this.getCachedTableColumnTypes(
        database,
        tableName,
        dataset,
        true,
      );
    }

    const allColumns = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach(k => allColumns.add(k));
    }
    const columns = Array.from(allColumns);
    const columnList = columns.map(escapeIdentifier).join(", ");

    const MAX_QUERY_SIZE = 900_000;
    let chunkSize = 1000; // Start smaller to be safe
    let totalWritten = 0;

    for (let i = 0; i < rows.length;) {
      // Build query for current chunk using VALUES syntax (more compact than SELECT...UNION ALL)
      let chunk = rows.slice(i, i + chunkSize);
      let query = this.buildInsertQuery(
        fullTableName,
        columnList,
        columns,
        chunk,
        columnTypes,
      );

      // If query is too large, reduce chunk size and retry
      while (query.length > MAX_QUERY_SIZE && chunkSize > 1) {
        chunkSize = Math.max(1, Math.floor(chunkSize / 2));
        chunk = rows.slice(i, i + chunkSize);
        query = this.buildInsertQuery(
          fullTableName,
          columnList,
          columns,
          chunk,
          columnTypes,
        );
      }

      // If still too large with minimum chunk size, fail with helpful error
      if (query.length > MAX_QUERY_SIZE) {
        return {
          success: false,
          rowsWritten: totalWritten,
          error: `Query size (${Math.round(query.length / 1024)}KB) exceeds BigQuery limit even with minimum batch size. Consider reducing data size per row or using BigQuery load jobs for very large data.`,
        };
      }

      let result = await this.executeQuery(database, query);
      let retryCount = 0;
      while (
        !result.success &&
        retryCount < 3 &&
        typeof result.error === "string"
      ) {
        const missingColumnError =
          result.error.includes("is not present in table") ||
          result.error.includes("Unrecognized name:");
        const requiredNullColumn = this.extractRequiredNullField(result.error);
        if (!missingColumnError && !requiredNullColumn) {
          break;
        }

        if (missingColumnError) {
          await this.addMissingColumns(database, tableName, dataset, chunk);
          columnTypes = await this.getCachedTableColumnTypes(
            database,
            tableName,
            dataset,
            true,
          );
          const retryColumns = Array.from(allColumns);
          const retryColumnList = retryColumns.map(escapeIdentifier).join(", ");
          query = this.buildInsertQuery(
            fullTableName,
            retryColumnList,
            retryColumns,
            chunk,
            columnTypes,
          );
        }

        if (requiredNullColumn) {
          const relax = await this.relaxRequiredColumn(
            database,
            tableName,
            dataset,
            requiredNullColumn,
          );
          if (!relax.success) {
            this.logger.warn("Failed to relax required column", {
              table: tableName,
              dataset,
              column: requiredNullColumn,
              error: relax.error,
            });
            break;
          }
        }

        await new Promise(resolve =>
          setTimeout(resolve, 500 * (retryCount + 1)),
        );
        result = await this.executeQuery(database, query);
        retryCount += 1;
      }

      if (!result.success) {
        const preview =
          rows.length > 0 ? JSON.stringify(rows[0]).slice(0, 1000) : "{}";
        this.logger.error("BigQuery insert failed", {
          table: tableName,
          dataset,
          error: result.error,
          retryCount,
          queryPreview: query.slice(0, 2000),
          firstRowPreview: preview,
          columnTypes: Object.fromEntries(columnTypes.entries()),
        });
        return {
          success: false,
          rowsWritten: totalWritten,
          error: result.error,
        };
      }

      totalWritten += chunk.length;
      i += chunk.length;

      // If query was well under the limit, try increasing chunk size for efficiency
      if (query.length < MAX_QUERY_SIZE * 0.5 && chunkSize < 2000) {
        chunkSize = Math.min(chunkSize * 2, 2000);
      }
    }

    return { success: true, rowsWritten: totalWritten };
  }

  /**
   * Build an INSERT query using VALUES syntax (more compact than SELECT...UNION ALL)
   * @param columnTypes - Optional map of column name -> BigQuery type for type coercion
   */
  private buildInsertQuery(
    fullTableName: string,
    columnList: string,
    columns: string[],
    rows: Record<string, unknown>[],
    columnTypes?: Map<string, string>,
  ): string {
    // Use VALUES syntax: INSERT INTO table (cols) VALUES (v1, v2), (v1, v2), ...
    const valueRows = rows.map(row => {
      const values = columns.map(col => {
        // Use lowercase for case-insensitive lookup
        const targetType = columnTypes?.get(col.toLowerCase());
        return formatBigQueryValue(row[col], targetType, true);
      });
      return `(${values.join(", ")})`;
    });

    return `INSERT INTO ${fullTableName} (${columnList}) VALUES\n${valueRows.join(",\n")};`;
  }

  /**
   * Upsert a batch of rows using MERGE statement
   * Chunks data adaptively to stay under BigQuery's 1MB query limit
   */
  async upsertBatch(
    database: IDatabaseConnection,
    tableName: string,
    rows: Record<string, unknown>[],
    keyColumns: string[],
    options?: UpsertOptions,
  ): Promise<BatchWriteResult> {
    if (rows.length === 0) {
      return { success: true, rowsWritten: 0 };
    }

    if (keyColumns.length === 0) {
      return {
        success: false,
        rowsWritten: 0,
        error: "Key columns required for upsert",
      };
    }

    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    if (!dataset) {
      return {
        success: false,
        rowsWritten: 0,
        error: "Dataset (schema) is required for BigQuery",
      };
    }

    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;
    const strategy = options?.conflictStrategy || "update";

    // Add any missing columns before writing
    await this.addMissingColumns(database, tableName, dataset, rows);

    // Get column types from INFORMATION_SCHEMA (after adding missing columns)
    let columnTypes = await this.getCachedTableColumnTypes(
      database,
      tableName,
      dataset,
    );

    if (columnTypes.size === 0) {
      this.logger.warn(
        "INFORMATION_SCHEMA returned no column types, forcing refresh",
        {
          table: tableName,
          dataset,
        },
      );
      columnTypes = await this.getCachedTableColumnTypes(
        database,
        tableName,
        dataset,
        true,
      );
    }

    // Get all unique column names from all rows
    const allColumns = new Set<string>();
    for (const row of rows) {
      Object.keys(row).forEach(k => allColumns.add(k));
    }
    let columns = Array.from(allColumns);

    // BigQuery has a 1MB (1,024,000 chars) query limit
    const MAX_QUERY_SIZE = 900_000; // Leave some buffer below 1MB
    let chunkSize = 500; // MERGE is more verbose, start smaller
    let totalWritten = 0;

    for (let i = 0; i < rows.length;) {
      // Build MERGE query for current chunk
      let chunk = rows.slice(i, i + chunkSize);
      let query = this.buildMergeQuery(
        fullTableName,
        columns,
        chunk,
        keyColumns,
        strategy,
        columnTypes,
      );

      // If query is too large, reduce chunk size and retry
      while (query.length > MAX_QUERY_SIZE && chunkSize > 1) {
        chunkSize = Math.max(1, Math.floor(chunkSize / 2));
        chunk = rows.slice(i, i + chunkSize);
        query = this.buildMergeQuery(
          fullTableName,
          columns,
          chunk,
          keyColumns,
          strategy,
          columnTypes,
        );
      }

      // If still too large with minimum chunk size, fail with helpful error
      if (query.length > MAX_QUERY_SIZE) {
        return {
          success: false,
          rowsWritten: totalWritten,
          error: `MERGE query size (${Math.round(query.length / 1024)}KB) exceeds BigQuery limit even with minimum batch size. Consider reducing data size per row.`,
        };
      }

      let result = await this.executeQuery(database, query);
      let retryCount = 0;
      while (
        !result.success &&
        retryCount < 3 &&
        typeof result.error === "string"
      ) {
        const missingColumnError =
          result.error.includes("is not present in table") ||
          result.error.includes("Unrecognized name:");
        const requiredNullColumn = this.extractRequiredNullField(result.error);
        if (!missingColumnError && !requiredNullColumn) {
          break;
        }

        if (missingColumnError) {
          await this.addMissingColumns(database, tableName, dataset, chunk);
          columnTypes = await this.getCachedTableColumnTypes(
            database,
            tableName,
            dataset,
            true,
          );
          columns = Array.from(allColumns);
          query = this.buildMergeQuery(
            fullTableName,
            columns,
            chunk,
            keyColumns,
            strategy,
            columnTypes,
          );
        }

        if (requiredNullColumn) {
          const relax = await this.relaxRequiredColumn(
            database,
            tableName,
            dataset,
            requiredNullColumn,
          );
          if (!relax.success) {
            this.logger.warn("Failed to relax required column for merge", {
              table: tableName,
              dataset,
              column: requiredNullColumn,
              error: relax.error,
            });
            break;
          }
        }

        await new Promise(resolve =>
          setTimeout(resolve, 500 * (retryCount + 1)),
        );
        result = await this.executeQuery(database, query);
        retryCount += 1;
      }

      if (!result.success) {
        const preview =
          rows.length > 0 ? JSON.stringify(rows[0]).slice(0, 1000) : "{}";
        this.logger.error("BigQuery merge failed", {
          table: tableName,
          dataset,
          error: result.error,
          queryPreview: query.slice(0, 2000),
          firstRowPreview: preview,
          columnTypes: Object.fromEntries(columnTypes.entries()),
        });
        return {
          success: false,
          rowsWritten: totalWritten,
          error: result.error,
        };
      }

      totalWritten += chunk.length;
      i += chunk.length;

      // If query was well under the limit, try increasing chunk size for efficiency
      if (query.length < MAX_QUERY_SIZE * 0.5 && chunkSize < 1000) {
        chunkSize = Math.min(chunkSize * 2, 1000);
      }
    }

    return { success: true, rowsWritten: totalWritten };
  }

  /**
   * Build a MERGE query using a more compact source format
   * Uses UNNEST with STRUCT array for better efficiency than SELECT...UNION ALL
   * @param columnTypes - Optional map of column name -> BigQuery type for type coercion
   *
   * IMPORTANT: We use SAFE_CAST for all values in STRUCTs to ensure consistent types.
   * Without this, if source data has mixed types (e.g., template_id is INT64 in one row
   * and STRING in another), BigQuery throws "Array elements of types do not have a
   * common supertype" because each STRUCT would have a different schema.
   */
  private buildMergeQuery(
    fullTableName: string,
    columns: string[],
    rows: Record<string, unknown>[],
    keyColumns: string[],
    strategy: string,
    columnTypes?: Map<string, string>,
  ): string {
    // Build source data using UNNEST with STRUCT - more compact than SELECT...UNION ALL
    // Format: UNNEST([STRUCT(v1 AS c1, v2 AS c2), STRUCT(v1 AS c1, v2 AS c2), ...])
    // We use useCast=true to ensure all STRUCTs have consistent column types via SAFE_CAST
    const structRows = rows.map(row => {
      const values = columns.map(col => {
        // Use lowercase for case-insensitive lookup
        const targetType = columnTypes?.get(col.toLowerCase());
        // useCast=true ensures consistent types across all STRUCTs in the array
        return `${formatBigQueryValue(row[col], targetType, true)} AS ${escapeIdentifier(col)}`;
      });
      return `STRUCT(${values.join(", ")})`;
    });

    const sourceQuery = `UNNEST([${structRows.join(", ")}])`;

    // Build MERGE conditions
    const joinConditions = keyColumns
      .map(k => `T.${escapeIdentifier(k)} = S.${escapeIdentifier(k)}`)
      .join(" AND ");

    // Build update and insert columns
    const nonKeyColumns = columns.filter(c => !keyColumns.includes(c));
    const updateClause =
      nonKeyColumns.length > 0
        ? `UPDATE SET ${nonKeyColumns.map(c => `${escapeIdentifier(c)} = S.${escapeIdentifier(c)}`).join(", ")}`
        : "";
    const hasSourceOrdering =
      columns.includes("_mako_source_ts") &&
      !keyColumns.includes("_mako_source_ts");
    const hasIngestOrdering =
      columns.includes("_mako_ingest_seq") &&
      !keyColumns.includes("_mako_ingest_seq");
    const matchedGuard = hasSourceOrdering
      ? ` AND COALESCE(S.${escapeIdentifier("_mako_source_ts")}, TIMESTAMP('1970-01-01 00:00:00 UTC')) >= COALESCE(T.${escapeIdentifier("_mako_source_ts")}, TIMESTAMP('1970-01-01 00:00:00 UTC'))`
      : hasIngestOrdering
        ? ` AND COALESCE(S.${escapeIdentifier("_mako_ingest_seq")}, -1) >= COALESCE(T.${escapeIdentifier("_mako_ingest_seq")}, -1)`
        : "";
    const insertColumns = columns.map(escapeIdentifier).join(", ");
    const insertValues = columns
      .map(c => `S.${escapeIdentifier(c)}`)
      .join(", ");

    if (strategy === "ignore") {
      // Only insert if not matched
      return `
        MERGE INTO ${fullTableName} T
        USING ${sourceQuery} AS S
        ON ${joinConditions}
        WHEN NOT MATCHED THEN
          INSERT (${insertColumns}) VALUES (${insertValues});
      `;
    } else {
      // Update when matched, insert when not matched
      return `
        MERGE INTO ${fullTableName} T
        USING ${sourceQuery} AS S
        ON ${joinConditions}
        ${updateClause ? `WHEN MATCHED${matchedGuard} THEN ${updateClause}` : ""}
        WHEN NOT MATCHED THEN
          INSERT (${insertColumns}) VALUES (${insertValues});
      `;
    }
  }

  /**
   * Create a staging table (copy of original table structure)
   */
  async createStagingTable(
    database: IDatabaseConnection,
    originalTableName: string,
    stagingTableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    const stagingDataset = options?.stagingSchema || dataset;
    if (!dataset) {
      return {
        success: false,
        error: "Dataset (schema) is required for BigQuery",
      };
    }
    if (!stagingDataset) {
      return {
        success: false,
        error: "Staging dataset is required for BigQuery",
      };
    }

    const fullOriginal = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(originalTableName)}`;
    const fullStaging = `${escapeIdentifier(projectId)}.${escapeIdentifier(stagingDataset)}.${escapeIdentifier(stagingTableName)}`;

    // Drop staging table if exists
    const dropResult = await this.executeQuery(
      database,
      `DROP TABLE IF EXISTS ${fullStaging};`,
    );
    if (!dropResult.success) {
      return { success: false, error: dropResult.error };
    }

    // When partition/cluster options are provided, we need explicit DDL
    // because CREATE TABLE AS SELECT WHERE FALSE loses layout config.
    if (options?.partitioning || options?.clustering) {
      const colTypes = await this.getTableColumnTypes(
        database,
        originalTableName,
        dataset,
      );
      if (colTypes.size === 0) {
        return {
          success: false,
          error: "Could not read original table schema for staging",
        };
      }

      const columns: ColumnDefinition[] = Array.from(colTypes.entries()).map(
        ([name, type]) => ({ name, type, nullable: true }),
      );
      return this.createTable(database, stagingTableName, columns, {
        ...options,
        schema: stagingDataset,
      });
    }

    const query = `CREATE TABLE ${fullStaging} AS SELECT * FROM ${fullOriginal} WHERE FALSE;`;
    const result = await this.executeQuery(database, query);

    return { success: result.success, error: result.error };
  }

  /**
   * Create a table from an existing source table's schema, preserving
   * partition/cluster layout from options, then copy all data.
   * Unlike CREATE TABLE ... AS SELECT, this retains partitioning config.
   */
  private async createTableWithLayoutFromSource(
    database: IDatabaseConnection,
    sourceTable: string,
    sourceSchema: string,
    targetTable: string,
    targetSchema: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const projectId = this.getProjectId(database);

    const colTypes = await this.getTableColumnTypes(
      database,
      sourceTable,
      sourceSchema,
    );
    if (colTypes.size === 0) {
      return {
        success: false,
        error: `Could not read schema from ${sourceSchema}.${sourceTable}`,
      };
    }

    const columns: ColumnDefinition[] = Array.from(colTypes.entries()).map(
      ([name, type]) => ({ name, type, nullable: true }),
    );

    const createResult = await this.createTable(
      database,
      targetTable,
      columns,
      { ...options, schema: targetSchema },
    );
    if (!createResult.success) {
      return createResult;
    }

    const fullSource = `${escapeIdentifier(projectId)}.${escapeIdentifier(sourceSchema)}.${escapeIdentifier(sourceTable)}`;
    const fullTarget = `${escapeIdentifier(projectId)}.${escapeIdentifier(targetSchema)}.${escapeIdentifier(targetTable)}`;
    const insertResult = await this.executeQuery(
      database,
      `INSERT INTO ${fullTarget} SELECT * FROM ${fullSource};`,
    );
    if (!insertResult.success) {
      return { success: false, error: insertResult.error };
    }

    return { success: true };
  }

  /**
   * Swap staging table with original
   * BigQuery doesn't support RENAME, so we recreate with explicit DDL
   * to preserve partition/cluster settings from options.
   */
  async swapStagingTable(
    database: IDatabaseConnection,
    originalTableName: string,
    stagingTableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    const stagingDataset = options?.stagingSchema || dataset;
    if (!dataset) {
      return {
        success: false,
        error: "Dataset (schema) is required for BigQuery",
      };
    }
    if (!stagingDataset) {
      return {
        success: false,
        error: "Staging dataset is required for BigQuery",
      };
    }

    const fullOriginal = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(originalTableName)}`;
    const fullStaging = `${escapeIdentifier(projectId)}.${escapeIdentifier(stagingDataset)}.${escapeIdentifier(stagingTableName)}`;
    const backupName = `${originalTableName}_backup_${Date.now()}`;
    const fullBackup = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(backupName)}`;

    const originalExists = await this.tableExists(database, originalTableName, {
      schema: dataset,
    });
    if (!originalExists) {
      const promoteResult = await this.createTableWithLayoutFromSource(
        database,
        stagingTableName,
        stagingDataset,
        originalTableName,
        dataset,
        options,
      );
      if (!promoteResult.success) {
        return {
          success: false,
          error: `Failed to create original from staging: ${promoteResult.error}`,
        };
      }

      await this.executeQuery(database, `DROP TABLE IF EXISTS ${fullStaging};`);
      return { success: true };
    }

    // Step 1: Backup original (CTAS is fine — backup is temporary and doesn't need partitioning)
    let result = await this.executeQuery(
      database,
      `CREATE TABLE ${fullBackup} AS SELECT * FROM ${fullOriginal};`,
    );
    if (!result.success) {
      return {
        success: false,
        error: `Failed to backup original: ${result.error}`,
      };
    }

    // Step 2: Drop original
    result = await this.executeQuery(database, `DROP TABLE ${fullOriginal};`);
    if (!result.success) {
      return {
        success: false,
        error: `Failed to drop original: ${result.error}`,
      };
    }

    // Step 3: Create new original with proper partition/cluster layout
    const swapResult = await this.createTableWithLayoutFromSource(
      database,
      stagingTableName,
      stagingDataset,
      originalTableName,
      dataset,
      options,
    );
    if (!swapResult.success) {
      // Restore from backup
      await this.executeQuery(
        database,
        `CREATE TABLE ${fullOriginal} AS SELECT * FROM ${fullBackup};`,
      );
      return {
        success: false,
        error: `Failed to create new table: ${swapResult.error}`,
      };
    }

    // Step 4: Drop staging and backup
    await this.executeQuery(database, `DROP TABLE IF EXISTS ${fullStaging};`);
    await this.executeQuery(database, `DROP TABLE IF EXISTS ${fullBackup};`);

    return { success: true };
  }

  /**
   * Create a table with the same schema as a source table, with optional
   * partitioning/clustering. Does NOT copy data.
   */
  async createTableFromSource(
    database: IDatabaseConnection,
    sourceTableName: string,
    targetTableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    if (!dataset) {
      return {
        success: false,
        error: "Dataset (schema) is required for BigQuery",
      };
    }

    const fullTarget = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(targetTableName)}`;
    const fullSource = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(sourceTableName)}`;

    const schemaResult = await this.executeQuery(
      database,
      `SELECT column_name, data_type FROM ${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.INFORMATION_SCHEMA.COLUMNS WHERE table_name = '${sourceTableName.replace(/'/g, "''")}' ORDER BY ordinal_position`,
    );
    if (!schemaResult.success) {
      return {
        success: false,
        error: `Schema discovery failed for ${fullSource}: ${schemaResult.error}`,
      };
    }
    if (!schemaResult.data?.length) {
      return {
        success: false,
        error: `Source table ${fullSource} not found or has no columns`,
      };
    }

    const colDefs = (schemaResult.data as any[])
      .map((r: any) => `${escapeIdentifier(r.column_name)} ${r.data_type}`)
      .join(",\n  ");

    const partitionClause = this.buildPartitionClause(options?.partitioning);
    const clusterClause = this.buildClusterClause(options?.clustering);
    const tableOptions = this.buildTableOptions(options?.partitioning);

    const query = `CREATE TABLE IF NOT EXISTS ${fullTarget} (\n  ${colDefs}\n)${partitionClause}${clusterClause}${tableOptions};`;
    const result = await this.executeQuery(database, query);
    return { success: result.success, error: result.error };
  }

  /**
   * Drop a table
   */
  async dropTable(
    database: IDatabaseConnection,
    tableName: string,
    options?: InsertOptions,
  ): Promise<{ success: boolean; error?: string }> {
    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    if (!dataset) {
      return {
        success: false,
        error: "Dataset (schema) is required for BigQuery",
      };
    }

    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;

    const query = `DROP TABLE IF EXISTS ${fullTableName};`;
    const result = await this.executeQuery(database, query);

    return { success: result.success, error: result.error };
  }

  /**
   * Delete rows matching the given key filters
   */
  async deleteBatch(
    database: IDatabaseConnection,
    tableName: string,
    keyFilters: Record<string, unknown>,
    options?: InsertOptions,
  ): Promise<BatchWriteResult> {
    const projectId = this.getProjectId(database);
    const dataset = options?.schema;
    if (!dataset) {
      return {
        success: false,
        rowsWritten: 0,
        error: "Dataset (schema) is required for BigQuery",
      };
    }

    const fullTableName = `${escapeIdentifier(projectId)}.${escapeIdentifier(dataset)}.${escapeIdentifier(tableName)}`;

    const conditions = Object.entries(keyFilters).map(([col, val]) => {
      if (val === null || val === undefined) {
        return `${escapeIdentifier(col)} IS NULL`;
      }
      const escaped = escapeForBigQueryString(String(val));
      return `${escapeIdentifier(col)} = '${escaped}'`;
    });

    if (conditions.length === 0) {
      return {
        success: false,
        rowsWritten: 0,
        error: "No key filters provided for delete",
      };
    }

    const query = `DELETE FROM ${fullTableName} WHERE ${conditions.join(" AND ")};`;
    const result = await this.executeQuery(database, query);

    return {
      success: result.success,
      rowsWritten: result.success ? 1 : 0,
      error: result.error,
    };
  }

  /**
   * Execute a streaming query with batched callbacks
   * Uses LIMIT/OFFSET pagination for BigQuery
   */
  async executeStreamingQuery(
    database: IDatabaseConnection,
    query: string,
    options: StreamingQueryOptions,
  ): Promise<{ success: boolean; totalRows: number; error?: string }> {
    const batchSize = options.batchSize || 10000; // BigQuery can handle larger batches
    let totalRows = 0;

    try {
      let offset = 0;
      let hasMore = true;

      while (hasMore) {
        // Check for cancellation
        if (options.signal?.aborted) {
          return { success: false, totalRows, error: "Query cancelled" };
        }

        // Add LIMIT/OFFSET to query
        const paginatedQuery = `${query.replace(/;?\s*$/, "")} LIMIT ${batchSize} OFFSET ${offset};`;

        const result = await this.executeQuery(database, paginatedQuery);

        if (!result.success) {
          return { success: false, totalRows, error: result.error };
        }

        const rows = result.data || [];
        if (rows.length === 0) {
          hasMore = false;
        } else {
          await options.onBatch(rows);
          totalRows += rows.length;
          offset += rows.length;

          // If we got fewer rows than batch size, we're done
          if (rows.length < batchSize) {
            hasMore = false;
          }
        }
      }

      return { success: true, totalRows };
    } catch (error) {
      return {
        success: false,
        totalRows,
        error:
          error instanceof Error ? error.message : "Streaming query failed",
      };
    }
  }
}

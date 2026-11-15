/**
 * The BigQuery engine: jobs over the REST API (jobs.query, then
 * getQueryResults pages), native preview pages and streams with job page
 * tokens, dry-run schemas, and cancellation by jobs.cancel — including of a
 * job we stopped waiting for.
 */
import type { AxiosInstance } from "axios";
import type { IDatabaseConnection } from "../../../database/workspace-schema";
import { loggers } from "../../../logging";
import { bigQueryJobLabels } from "../../../services/bigquery-labels";
import { createBigQueryPollBudget } from "../../../services/bigquery-poll-budget";
import {
  buildBigQueryCursor,
  checkPreviewQuerySafety,
  decodePreviewCursor,
  hashPreviewQuery,
  resolvePreviewPageSize,
} from "../../../services/query-pagination.service";
import { isLocalBigQueryEmulator } from "../../../utils/bigquery-emulator";
import type { QueryEngine } from "../../engine";
import {
  QUERY_NOT_FOUND,
  type CancelResult,
  type ConnectionTestResult,
  type DatabaseQuery,
  type QueryExecuteOptions,
  type QueryPreviewOptions,
  type QueryPreviewResult,
  type QueryResult,
  type StreamingQueryOptions,
  type StreamingQueryResult,
} from "../../query-types";
import { BigQueryClients } from "./client";
import { abandonedSuffix, describeGoogleApiError } from "./errors";
import {
  flattenSchemaFields,
  mapRowsToObjects,
  schemaToFields,
  type BigQueryRow,
  type BigQuerySchema,
} from "./rows";

const logger = loggers.db("bigquery");

/** The BigQuery fields of a saved connection. */
export interface BigQueryConnectionConfig {
  project_id?: string;
  service_account_json?: string | object;
  location?: string;
  api_base_url?: string;
}

export function bigQueryConfig(
  database: IDatabaseConnection,
): BigQueryConnectionConfig {
  return (database.connection as BigQueryConnectionConfig) || {};
}

export const MISSING_CREDENTIALS =
  "BigQuery requires 'project_id' and 'service_account_json' in connection";

/** What jobs.query and getQueryResults answer (the parts read here). */
interface QueryResponse {
  jobComplete?: boolean;
  jobReference?: { jobId?: string; location?: string };
  schema?: BigQuerySchema;
  rows?: BigQueryRow[];
  pageToken?: string;
  errors?: Array<{ reason?: string; message?: string }>;
  numDmlAffectedRows?: string;
}

interface RunningJob {
  projectId: string;
  jobId: string;
  location?: string;
  client: AxiosInstance;
}

export class BigQueryEngine implements QueryEngine {
  readonly runningJobs = new Map<string, RunningJob>();
  private readonly clients = new BigQueryClients();

  /**
   * The REST client for a service account; asked for again per poll and
   * per page where a job can outlive a token, since this call renews it.
   */
  getHttpClient(
    serviceAccountJson: string | object,
    apiBaseUrl?: string,
  ): Promise<AxiosInstance> {
    return this.clients.getHttpClient(serviceAccountJson, apiBaseUrl);
  }

  /** Stateless HTTP: there is no connection to hand out. */
  async getConnection(): Promise<null> {
    return null;
  }

  getPollIntervalMs(): number {
    const configured = Number.parseInt(
      process.env.BIGQUERY_QUERY_POLL_INTERVAL_MS || "",
      10,
    );
    if (!Number.isFinite(configured)) {
      return 1000;
    }
    return Math.max(100, configured);
  }

  /**
   * The `labels` map for a BigQuery job on this connection (see
   * bigquery-labels.ts), or undefined for a local emulator: emulator jobs
   * cost nothing, and an emulator that rejects the field must not fail them.
   */
  private jobLabels(
    database: IDatabaseConnection,
    apiBaseUrl: string | undefined,
    options?: Pick<QueryExecuteOptions, "labels">,
  ): Record<string, string> | undefined {
    if (isLocalBigQueryEmulator(apiBaseUrl)) return undefined;
    return bigQueryJobLabels({
      workspaceId: database.workspaceId,
      explicit: options?.labels,
    });
  }

  async testConnection(
    database: IDatabaseConnection,
  ): Promise<ConnectionTestResult> {
    try {
      const { project_id, service_account_json, location, api_base_url } =
        bigQueryConfig(database);
      if (!project_id || !service_account_json) {
        return {
          success: false,
          error: MISSING_CREDENTIALS,
        };
      }

      const client = await this.getHttpClient(
        service_account_json,
        api_base_url,
      );
      const body: Record<string, unknown> = {
        query: "SELECT 1 AS one",
        useLegacySql: false,
        maxResults: 1,
      };
      if (location) body.location = location;
      const labels = this.jobLabels(database, api_base_url, {
        labels: { mako_source: "connection_test" },
      });
      if (labels) body.labels = labels;
      await client.post(`/projects/${project_id}/queries`, body);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: describeGoogleApiError(error, "BigQuery connection failed"),
      };
    }
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: DatabaseQuery,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    const executionId = options?.executionId;
    const signal = options?.signal;

    const checkAborted = () => {
      if (signal?.aborted) throw new Error("Query cancelled");
    };

    try {
      checkAborted();
      if (typeof query !== "string" || !query.trim()) {
        return { success: false, error: "Query must be a non-empty string" };
      }
      const {
        project_id,
        service_account_json,
        location: dbLocation,
        api_base_url,
      } = bigQueryConfig(database);
      if (!project_id || !service_account_json) {
        return {
          success: false,
          error: MISSING_CREDENTIALS,
        };
      }

      const client = await this.getHttpClient(
        service_account_json,
        api_base_url,
      );
      const configuredLocation = options?.location || dbLocation;
      const batchSize = Math.max(
        1,
        Math.min(10000, options?.batchSize || 1000),
      );

      // Start the query
      const startBody: Record<string, unknown> = {
        query,
        useLegacySql: false,
        maxResults: batchSize,
      };
      if (configuredLocation) startBody.location = configuredLocation;
      const labels = this.jobLabels(database, api_base_url, options);
      if (labels) startBody.labels = labels;
      checkAborted();
      let response = await client.post(
        `/projects/${project_id}/queries`,
        startBody,
      );

      let data: QueryResponse = response.data || {};
      const jobId: string | undefined = data.jobReference?.jobId;
      const jobLocation: string | undefined =
        data.jobReference?.location || configuredLocation;
      let schema = data.schema;
      let pageToken: string | undefined = data.pageToken;
      const rowsAccum: Record<string, unknown>[] = [];

      // Track running job for cancellation
      if (executionId && jobId) {
        this.runningJobs.set(executionId, {
          projectId: project_id,
          jobId,
          location: jobLocation,
          client,
        });
      }

      // Wait for job completion (interactive default 5m; sync MERGE etc. pass bigQueryJobMaxWaitMs)
      const configuredMax = options?.bigQueryJobMaxWaitMs;
      const maxWaitMs = Math.min(
        Math.max(
          typeof configuredMax === "number" &&
            Number.isFinite(configuredMax) &&
            configuredMax > 0
            ? configuredMax
            : 5 * 60 * 1000,
          1000,
        ),
        60 * 60 * 1000,
      );
      const pollIntervalMs = this.getPollIntervalMs();
      // A wall-clock deadline: see bigquery-poll-budget.ts for why counting
      // only the sleeps turned 5 minutes into 55.
      const budget = createBigQueryPollBudget(maxWaitMs);

      while (data.jobComplete === false && jobId && !budget.expired()) {
        checkAborted();
        await new Promise(resolve =>
          setTimeout(resolve, budget.sleepMs(pollIntervalMs)),
        );
        checkAborted();
        if (budget.expired()) break;

        const params: Record<string, unknown> = {
          maxResults: batchSize,
          timeoutMs: budget.requestTimeoutMs(),
        };
        if (jobLocation) params.location = jobLocation;
        response = await client.get(
          `/projects/${project_id}/queries/${jobId}`,
          { params },
        );
        data = response.data || {};
        schema = data.schema || schema;
      }

      checkAborted();
      if (data.jobComplete === false) {
        const stopped = await this.cancelAbandonedJob({
          client,
          projectId: project_id,
          jobId: jobId as string,
          location: jobLocation,
          executionId,
        });
        return {
          success: false,
          error: `Query timed out after ${maxWaitMs / 1000} seconds${abandonedSuffix(stopped)}`,
        };
      }

      if (Array.isArray(data.errors) && data.errors.length > 0) {
        const fatalErrors = data.errors.filter(
          (e: { reason?: string }) => e?.reason !== "warning",
        );
        if (fatalErrors.length > 0) {
          return {
            success: false,
            error: fatalErrors
              .map(
                (e: { message?: string }) =>
                  (e && typeof e.message === "string" && e.message) ||
                  "BigQuery job error",
              )
              .join("; "),
          };
        }
      }

      // Collect results
      if (Array.isArray(data.rows) && schema) {
        const page = mapRowsToObjects(data.rows, schema);
        options?.onRows?.(page);
        rowsAccum.push(...page);
      }
      pageToken = data.pageToken;

      while (pageToken) {
        checkAborted();
        const params: Record<string, unknown> = { maxResults: batchSize };
        if (pageToken) params.pageToken = pageToken;
        if (jobLocation) params.location = jobLocation;
        response = await client.get(
          `/projects/${project_id}/queries/${jobId}`,
          { params },
        );
        data = response.data || {};
        schema = data.schema || schema;
        if (Array.isArray(data.rows) && schema) {
          const page = mapRowsToObjects(data.rows, schema);
          options?.onRows?.(page);
          rowsAccum.push(...page);
        }
        pageToken = data.pageToken;
      }

      // A DML statement returns no rows; BigQuery says how many it changed.
      const affected = Number(data.numDmlAffectedRows);
      return {
        success: true,
        data: rowsAccum,
        rowCount:
          rowsAccum.length === 0 && Number.isFinite(affected)
            ? affected
            : rowsAccum.length,
      };
    } catch (error) {
      if ((error as Error | null)?.message === "Query cancelled") {
        return { success: false, error: "Query cancelled" };
      }
      return {
        success: false,
        error: describeGoogleApiError(error, "BigQuery query failed"),
      };
    } finally {
      if (executionId) this.runningJobs.delete(executionId);
    }
  }

  async executePreviewQuery(
    database: IDatabaseConnection,
    query: string,
    options?: QueryPreviewOptions,
  ): Promise<QueryPreviewResult> {
    const baseQuery = query.trim().replace(/;\s*$/, "");
    const safety = checkPreviewQuerySafety(baseQuery, "bigquery");
    if (!safety.safe) {
      return { success: false, error: safety.errors.join(" ") };
    }

    const decodedCursor = decodePreviewCursor(options?.cursor);
    const queryHash = hashPreviewQuery(baseQuery);
    if (decodedCursor && decodedCursor.queryHash !== queryHash) {
      return {
        success: false,
        error: "The provided preview cursor does not match the current query",
      };
    }
    if (decodedCursor && decodedCursor.kind !== "bigquery") {
      return {
        success: false,
        error: "The provided preview cursor is invalid for this BigQuery query",
      };
    }

    const {
      project_id,
      service_account_json,
      location: dbLocation,
      api_base_url,
    } = bigQueryConfig(database);
    if (!project_id || !service_account_json) {
      return {
        success: false,
        error: MISSING_CREDENTIALS,
      };
    }

    const { pageSize, capApplied } = resolvePreviewPageSize(options?.pageSize);
    const client = await this.getHttpClient(service_account_json, api_base_url);
    const configuredLocation =
      decodedCursor?.kind === "bigquery"
        ? decodedCursor.location || options?.location || dbLocation
        : options?.location || dbLocation;
    const executionId = options?.executionId;
    const signal = options?.signal;

    const checkAborted = () => {
      if (signal?.aborted) throw new Error("Query cancelled");
    };

    try {
      checkAborted();

      let response;
      let data: QueryResponse = {};
      let jobId: string | undefined =
        decodedCursor?.kind === "bigquery" ? decodedCursor.jobId : undefined;
      let jobLocation: string | undefined = configuredLocation;

      if (decodedCursor?.kind === "bigquery") {
        const params: Record<string, unknown> = {
          maxResults: pageSize,
          pageToken: decodedCursor.pageToken,
        };
        if (jobLocation) {
          params.location = jobLocation;
        }
        response = await client.get(
          `/projects/${project_id}/queries/${jobId}`,
          {
            params,
          },
        );
        data = response.data || {};
      } else {
        const startBody: Record<string, unknown> = {
          query: baseQuery,
          useLegacySql: false,
          maxResults: pageSize,
        };
        if (configuredLocation) {
          startBody.location = configuredLocation;
        }
        const labels = this.jobLabels(database, api_base_url, options);
        if (labels) startBody.labels = labels;

        response = await client.post(
          `/projects/${project_id}/queries`,
          startBody,
        );
        data = response.data || {};
        jobId = data.jobReference?.jobId;
        jobLocation = data.jobReference?.location || configuredLocation;
      }

      if (executionId && jobId) {
        this.runningJobs.set(executionId, {
          projectId: project_id,
          jobId,
          location: jobLocation,
          client,
        });
      }

      const maxWaitMs = 5 * 60 * 1000;
      const pollIntervalMs = this.getPollIntervalMs();
      // A wall-clock deadline: see bigquery-poll-budget.ts.
      const budget = createBigQueryPollBudget(maxWaitMs);

      while (data.jobComplete === false && jobId && !budget.expired()) {
        checkAborted();
        await new Promise(resolve =>
          setTimeout(resolve, budget.sleepMs(pollIntervalMs)),
        );
        checkAborted();
        if (budget.expired()) break;

        const params: Record<string, unknown> = {
          maxResults: pageSize,
          timeoutMs: budget.requestTimeoutMs(),
        };
        if (jobLocation) {
          params.location = jobLocation;
        }
        if (decodedCursor?.kind === "bigquery" && decodedCursor.pageToken) {
          params.pageToken = decodedCursor.pageToken;
        }

        response = await client.get(
          `/projects/${project_id}/queries/${jobId}`,
          {
            params,
          },
        );
        data = response.data || {};
      }

      checkAborted();
      if (data.jobComplete === false) {
        const stopped = await this.cancelAbandonedJob({
          client,
          projectId: project_id,
          jobId: jobId as string,
          location: jobLocation,
          executionId,
        });
        return {
          success: false,
          error: `Query timed out after ${maxWaitMs / 1000} seconds${abandonedSuffix(stopped)}`,
        };
      }

      const schema = data.schema;
      const rows =
        Array.isArray(data.rows) && schema
          ? (mapRowsToObjects(data.rows, schema) as Array<
              Record<string, unknown>
            >)
          : [];
      const fields = schemaToFields(schema, rows);
      const nextPageToken =
        typeof data.pageToken === "string" && data.pageToken.length > 0
          ? data.pageToken
          : undefined;

      return {
        success: true,
        rows,
        rowCount: rows.length,
        fields,
        warnings: safety.warnings,
        pageInfo: {
          pageSize,
          hasMore: Boolean(nextPageToken),
          nextCursor:
            nextPageToken && jobId
              ? buildBigQueryCursor({
                  jobId,
                  pageToken: nextPageToken,
                  query: baseQuery,
                  location: jobLocation,
                })
              : null,
          returnedRows: rows.length,
          capApplied,
        },
      };
    } catch (error) {
      if ((error as Error | null)?.message === "Query cancelled") {
        return { success: false, error: "Query cancelled" };
      }
      return {
        success: false,
        error: describeGoogleApiError(error, "BigQuery preview query failed"),
      };
    } finally {
      if (executionId) {
        this.runningJobs.delete(executionId);
      }
    }
  }

  async executeStreamingQuery(
    database: IDatabaseConnection,
    query: string,
    options: StreamingQueryOptions & QueryExecuteOptions,
  ): Promise<StreamingQueryResult> {
    const executionId = options.executionId;
    const signal = options.signal;

    const checkAborted = () => {
      if (signal?.aborted) throw new Error("Query cancelled");
    };

    let totalRows = 0;

    try {
      checkAborted();
      if (typeof query !== "string" || !query.trim()) {
        return {
          success: false,
          totalRows,
          error: "Query must be a non-empty string",
        };
      }

      const {
        project_id,
        service_account_json,
        location: dbLocation,
        api_base_url,
      } = bigQueryConfig(database);
      if (!project_id || !service_account_json) {
        return {
          success: false,
          totalRows,
          error: MISSING_CREDENTIALS,
        };
      }

      // Asked for again per poll and per page: a job or a stream can outlive
      // the token it started with (smp0's 250+ seconds of pages ended in a 401
      // for two deploys on 2026-11-03), and this call is what renews it.
      let client = await this.getHttpClient(service_account_json, api_base_url);
      const configuredLocation = options.location || dbLocation;
      const batchSize = Math.max(1, Math.min(10000, options.batchSize || 1000));

      const startBody: Record<string, unknown> = {
        query,
        useLegacySql: false,
        maxResults: batchSize,
      };
      if (configuredLocation) {
        startBody.location = configuredLocation;
      }
      const labels = this.jobLabels(database, api_base_url, options);
      if (labels) startBody.labels = labels;

      checkAborted();
      let response = await client.post(
        `/projects/${project_id}/queries`,
        startBody,
      );
      let data: QueryResponse = response.data || {};
      const jobId: string | undefined = data.jobReference?.jobId;
      const jobLocation: string | undefined =
        data.jobReference?.location || configuredLocation;
      let schema = data.schema;
      let pageToken: string | undefined = data.pageToken;

      if (executionId && jobId) {
        this.runningJobs.set(executionId, {
          projectId: project_id,
          jobId,
          location: jobLocation,
          client,
        });
      }

      const maxWaitMs = 5 * 60 * 1000;
      const pollIntervalMs = this.getPollIntervalMs();
      // A wall-clock deadline: see bigquery-poll-budget.ts.
      const budget = createBigQueryPollBudget(maxWaitMs);

      while (data.jobComplete === false && jobId && !budget.expired()) {
        checkAborted();
        await new Promise(resolve =>
          setTimeout(resolve, budget.sleepMs(pollIntervalMs)),
        );
        checkAborted();
        if (budget.expired()) break;

        const params: Record<string, unknown> = {
          maxResults: batchSize,
          timeoutMs: budget.requestTimeoutMs(),
        };
        if (jobLocation) {
          params.location = jobLocation;
        }
        client = await this.getHttpClient(service_account_json, api_base_url);
        response = await client.get(
          `/projects/${project_id}/queries/${jobId}`,
          {
            params,
          },
        );
        data = response.data || {};
        schema = data.schema || schema;
      }

      checkAborted();
      if (data.jobComplete === false) {
        const stopped = await this.cancelAbandonedJob({
          client,
          projectId: project_id,
          jobId: jobId as string,
          location: jobLocation,
          executionId,
        });
        return {
          success: false,
          totalRows,
          error: `Query timed out after ${maxWaitMs / 1000} seconds${abandonedSuffix(stopped)}`,
        };
      }

      if (Array.isArray(data.rows) && schema) {
        const rows = mapRowsToObjects(data.rows, schema) as Array<
          Record<string, unknown>
        >;
        if (rows.length > 0) {
          await options.onBatch(rows);
          totalRows += rows.length;
        }
      }

      pageToken = data.pageToken;

      while (pageToken && jobId) {
        checkAborted();
        const params: Record<string, unknown> = {
          maxResults: batchSize,
          pageToken,
        };
        if (jobLocation) {
          params.location = jobLocation;
        }
        client = await this.getHttpClient(service_account_json, api_base_url);
        response = await client.get(
          `/projects/${project_id}/queries/${jobId}`,
          {
            params,
          },
        );
        data = response.data || {};
        schema = data.schema || schema;

        const rows =
          Array.isArray(data.rows) && schema
            ? (mapRowsToObjects(data.rows, schema) as Array<
                Record<string, unknown>
              >)
            : [];
        if (rows.length > 0) {
          await options.onBatch(rows);
          totalRows += rows.length;
        }

        pageToken = data.pageToken;
      }

      return { success: true, totalRows };
    } catch (error) {
      if ((error as Error | null)?.message === "Query cancelled") {
        return { success: false, totalRows, error: "Query cancelled" };
      }
      return {
        success: false,
        totalRows,
        error: describeGoogleApiError(error, "BigQuery streaming query failed"),
      };
    } finally {
      if (executionId) {
        this.runningJobs.delete(executionId);
      }
    }
  }

  /**
   * Stop a job we have stopped waiting for.
   *
   * When the poll loop gives up at `maxWaitMs` the HTTP request ends, but the
   * BigQuery job does not: it runs to completion, scans what it was going to
   * scan, and bills for it — which is what "the query may still be running in
   * BigQuery" in the timeout message has always meant. Nobody reads the
   * result, so every byte after we walk away is paid for and thrown away.
   *
   * Measured on 2026-09-01: one app's two bindings abandoned 41 jobs in 48
   * minutes, each a 300s query. The circuit breaker in front of live bindings
   * cut that to 7; this makes the ones that still happen stop scanning.
   *
   * Best effort by construction — it runs on a path that is already failing,
   * so a failed cancel must not replace the timeout the caller needs to hear
   * about. Returns whether the job was actually cancelled, so the message can
   * say which happened instead of always claiming the worse one.
   */
  async cancelAbandonedJob(input: {
    client: AxiosInstance;
    projectId: string;
    jobId: string;
    location?: string;
    executionId?: string;
  }): Promise<boolean> {
    const { client, projectId, jobId, location, executionId } = input;
    try {
      const params: Record<string, string> = {};
      if (location) params.location = location;
      await client.post(
        `/projects/${projectId}/jobs/${jobId}/cancel`,
        {},
        { params },
      );
      if (executionId) this.runningJobs.delete(executionId);
      logger.info("Cancelled an abandoned BigQuery job", {
        category: "db.bigquery",
        projectId,
        jobId,
      });
      return true;
    } catch (error) {
      logger.warn("Could not cancel an abandoned BigQuery job", {
        category: "db.bigquery",
        projectId,
        jobId,
        error: describeGoogleApiError(error, "Failed to cancel job"),
      });
      return false;
    }
  }

  async cancelQuery(executionId: string): Promise<CancelResult> {
    if (!this.runningJobs.has(executionId)) {
      return { success: false, error: QUERY_NOT_FOUND };
    }
    return this.cancelJob(executionId);
  }

  /**
   * Cancel a running BigQuery job
   */
  async cancelJob(
    executionId: string,
  ): Promise<{ success: boolean; error?: string }> {
    const job = this.runningJobs.get(executionId);
    if (!job) {
      return { success: false, error: "Job not found or already completed" };
    }

    try {
      const params: Record<string, unknown> = {};
      if (job.location) params.location = job.location;
      await job.client.post(
        `/projects/${job.projectId}/jobs/${job.jobId}/cancel`,
        {},
        { params },
      );
      this.runningJobs.delete(executionId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error: describeGoogleApiError(error, "Failed to cancel job"),
      };
    }
  }

  /**
   * Get the schema (column types) of a BigQuery query without executing it.
   * Uses BigQuery's dry run feature which validates the query and returns
   * the result schema without actually running it.
   *
   * This is more reliable than inferring types from sample data because:
   * - NULL values are handled correctly (column type is known)
   * - No data sampling variance issues
   * - Works even if query returns 0 rows
   *
   * @param database - BigQuery database connection
   * @param query - SQL query to analyze
   * @returns Column definitions with name and BigQuery type
   */
  async getQuerySchema(
    database: IDatabaseConnection,
    query: string,
  ): Promise<{
    success: boolean;
    columns?: Array<{ name: string; type: string; nullable: boolean }>;
    error?: string;
  }> {
    try {
      const { project_id, service_account_json, location, api_base_url } =
        bigQueryConfig(database);
      if (!project_id || !service_account_json) {
        return {
          success: false,
          error: MISSING_CREDENTIALS,
        };
      }

      const client = await this.getHttpClient(
        service_account_json,
        api_base_url,
      );

      // Use dry run to get schema without executing
      const body: Record<string, unknown> = {
        query,
        useLegacySql: false,
        dryRun: true, // Key: validates query and returns schema without running
      };
      if (location) body.location = location;
      const labels = this.jobLabels(database, api_base_url);
      if (labels) body.labels = labels;

      const response = await client.post(
        `/projects/${project_id}/queries`,
        body,
      );

      const schema = response?.data?.schema;
      if (!schema?.fields) {
        return {
          success: false,
          error: "No schema returned from dry run query",
        };
      }

      // Map BigQuery schema fields to column definitions
      const columns = flattenSchemaFields(schema.fields);

      return { success: true, columns };
    } catch (error) {
      return {
        success: false,
        error: describeGoogleApiError(error, "Failed to get query schema"),
      };
    }
  }
}

export const bigQueryEngine = new BigQueryEngine();

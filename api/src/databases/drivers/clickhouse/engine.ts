/**
 * The ClickHouse engine: one HTTP client per query (nothing pooled), and
 * cancellation by `KILL QUERY WHERE query_id = …`.
 */
import { createClient } from "@clickhouse/client";
import crypto from "crypto";
import type { IDatabaseConnection } from "../../../database/workspace-schema";
import { loggers } from "../../../logging";
import type { QueryEngine } from "../../engine";
import {
  QUERY_NOT_FOUND,
  type CancelResult,
  type ConnectionTestResult,
  type DatabaseQuery,
  type QueryExecuteOptions,
  type QueryResult,
} from "../../query-types";
import { withRetry } from "../../retry";
import {
  buildClickHouseClientConfig,
  CLICKHOUSE_MAX_RETRIES,
  CLICKHOUSE_RETRY_BASE_DELAY_MS,
} from "./config";

const logger = loggers.db("clickhouse");

interface RunningClickHouseQuery {
  database: IDatabaseConnection;
  queryId: string;
  abortController: AbortController;
}

function cancelled(error: unknown, signal: AbortSignal): boolean {
  const { name, message } = (error ?? {}) as {
    name?: string;
    message?: string;
  };
  return (
    name === "AbortError" ||
    !!message?.includes("aborted") ||
    !!message?.includes("cancelled") ||
    signal.aborted
  );
}

export class ClickHouseEngine implements QueryEngine {
  readonly runningQueries = new Map<string, RunningClickHouseQuery>();

  /** Stateless HTTP: there is no connection to hand out. */
  async getConnection(): Promise<null> {
    return null;
  }

  async testConnection(
    database: IDatabaseConnection,
  ): Promise<ConnectionTestResult> {
    try {
      const config = buildClickHouseClientConfig(database);

      // Use retry logic to handle cold starts and transient failures
      await withRetry(
        async () => {
          const client = createClient(config);
          try {
            await client.ping();
          } finally {
            await client.close();
          }
        },
        {
          maxRetries: CLICKHOUSE_MAX_RETRIES,
          baseDelayMs: CLICKHOUSE_RETRY_BASE_DELAY_MS,
        },
      );

      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "ClickHouse connection failed",
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
    const abortController = new AbortController();

    // Generate unique query_id for this execution
    const queryId = executionId || crypto.randomUUID();

    // Removed in finally: a reused signal must not collect listeners.
    const abortHandler = () => {
      abortController.abort();
    };
    if (signal) {
      signal.addEventListener("abort", abortHandler);
    }

    try {
      if (signal?.aborted) {
        return { success: false, error: "Query cancelled" };
      }

      // Honor a per-query database selection (cluster mode) so unqualified
      // table references resolve against the chosen database, not just the
      // connection's default.
      const config = buildClickHouseClientConfig(
        database,
        options?.databaseName,
      );

      if (executionId) {
        this.runningQueries.set(executionId, {
          database,
          queryId,
          abortController,
        });
      }

      // Retry only connection establishment, never the query: re-running an
      // INSERT or ALTER would duplicate its side effects.
      const client = await withRetry(
        async () => {
          const newClient = createClient(config);
          try {
            await newClient.ping();
            return newClient;
          } catch (error) {
            await newClient.close().catch(() => {});
            throw error;
          }
        },
        {
          maxRetries: CLICKHOUSE_MAX_RETRIES,
          baseDelayMs: CLICKHOUSE_RETRY_BASE_DELAY_MS,
          signal: abortController.signal,
        },
      );

      let data: unknown[];
      try {
        // query_id makes the query cancellable (KILL QUERY).
        const resultSet = await client.query({
          query: query as string,
          format: "JSONEachRow",
          query_id: queryId,
          clickhouse_settings: {
            // Allow query to be cancelled
            cancel_http_readonly_queries_on_client_close: 1,
            ...(options?.readOnly || options?.readOnlyTransaction
              ? { readonly: "2" }
              : {}),
          },
          abort_signal: abortController.signal,
        });

        data = await resultSet.json();
      } finally {
        await client.close();
      }

      return {
        success: true,
        data,
        rowCount: data.length,
      };
    } catch (error) {
      if (cancelled(error, abortController.signal)) {
        return { success: false, error: "Query cancelled" };
      }
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "ClickHouse query failed",
      };
    } finally {
      if (signal) {
        signal.removeEventListener("abort", abortHandler);
      }
      if (executionId) {
        this.runningQueries.delete(executionId);
      }
    }
  }

  async cancelQuery(executionId: string): Promise<CancelResult> {
    const query = this.runningQueries.get(executionId);
    if (!query) {
      return { success: false, error: QUERY_NOT_FOUND };
    }

    try {
      // First, abort the JavaScript promise
      query.abortController.abort();

      // Then try to kill the query on the server side
      try {
        const client = createClient(
          buildClickHouseClientConfig(query.database),
        );
        await client.query({
          query: `KILL QUERY WHERE query_id = '${query.queryId}'`,
        });
        await client.close();
      } catch (killError) {
        // Killing the query might fail if it already completed, which is okay
        logger.warn("Could not kill ClickHouse query", {
          queryId: query.queryId,
          error: killError,
        });
      }

      this.runningQueries.delete(executionId);
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to cancel query",
      };
    }
  }
}

export const clickHouseEngine = new ClickHouseEngine();

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
import { isRetryableError, withRetry } from "../../retry";
import {
  buildClickHouseClientConfig,
  CLICKHOUSE_MAX_RETRIES,
  CLICKHOUSE_RETRY_BASE_DELAY_MS,
  CLICKHOUSE_WAKE_ATTEMPT_TIMEOUT_MS,
  CLICKHOUSE_WAKE_BASE_DELAY_MS,
  CLICKHOUSE_WAKE_MAX_DELAY_MS,
  resolveClickHouseWakeTimeoutMs,
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

type ClickHouseClientConfig = ReturnType<typeof buildClickHouseClientConfig>;
type ClickHouseClient = ReturnType<typeof createClient>;

/** Test seams: the client factory and the clock. */
export interface ClickHouseConnectDeps {
  createClient: (config: ClickHouseClientConfig) => ClickHouseClient;
  now: () => number;
  sleep: (ms: number, signal?: AbortSignal) => Promise<void>;
}

function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new Error("Operation cancelled"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error("Operation cancelled"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

const defaultConnectDeps: ClickHouseConnectDeps = {
  createClient: config => createClient(config),
  now: () => Date.now(),
  sleep: abortableSleep,
};

/**
 * One health check. `client.ping()` reports a failure in its result instead of
 * throwing, so the failure is rethrown here for the retry logic to see it.
 * `select: true` sends `SELECT 1`, a real query, which wakes an idle
 * ClickHouse Cloud service.
 */
async function pingOrThrow(
  client: ClickHouseClient,
  signal?: AbortSignal,
): Promise<void> {
  const result = await client.ping({ select: true, abort_signal: signal });
  if (!result.success) throw result.error;
}

/**
 * Open a client that has answered `SELECT 1`.
 *
 * With a wake timeout (see resolveClickHouseWakeTimeoutMs), a server that is
 * asleep or starting is retried until it answers or the timeout runs out:
 * each attempt waits at most 30 s, and the pause between attempts grows from
 * 2 s to 30 s. Without one, a failed check is retried 3 times (1, 2, 4 s).
 * Only the health check is retried, never the caller's query.
 */
export async function connectClickHouse(
  database: IDatabaseConnection,
  config: ClickHouseClientConfig,
  signal?: AbortSignal,
  deps: ClickHouseConnectDeps = defaultConnectDeps,
): Promise<ClickHouseClient> {
  const wakeTimeoutMs = resolveClickHouseWakeTimeoutMs(database, config.url);

  if (wakeTimeoutMs <= 0) {
    return withRetry(
      async () => {
        const client = deps.createClient(config);
        try {
          await pingOrThrow(client, signal);
          return client;
        } catch (error) {
          await client.close().catch(() => {});
          throw error;
        }
      },
      {
        maxRetries: CLICKHOUSE_MAX_RETRIES,
        baseDelayMs: CLICKHOUSE_RETRY_BASE_DELAY_MS,
        signal,
      },
    );
  }

  const startedAt = deps.now();
  const deadline = startedAt + wakeTimeoutMs;
  let delayMs = CLICKHOUSE_WAKE_BASE_DELAY_MS;
  let attempts = 0;

  for (;;) {
    if (signal?.aborted) throw new Error("Operation cancelled");
    attempts += 1;
    const remaining = Math.max(1_000, deadline - deps.now());
    const probe = deps.createClient({
      ...config,
      request_timeout: Math.min(CLICKHOUSE_WAKE_ATTEMPT_TIMEOUT_MS, remaining),
    });
    try {
      await pingOrThrow(probe, signal);
      await probe.close().catch(() => {});
      if (attempts > 1) {
        logger.info("ClickHouse answered after waking", {
          attempts,
          waitedMs: deps.now() - startedAt,
        });
      }
      return deps.createClient(config);
    } catch (error) {
      await probe.close().catch(() => {});
      const err = error instanceof Error ? error : new Error(String(error));
      if (!isRetryableError(err) || signal?.aborted) throw err;
      const left = deadline - deps.now();
      if (left <= 0) {
        throw new Error(
          `ClickHouse did not answer within ${Math.round(wakeTimeoutMs / 1000)} s ` +
            `(${attempts} attempts; the server may be asleep or starting): ${err.message}`,
          { cause: error },
        );
      }
      logger.debug("ClickHouse not ready, retrying", {
        attempt: attempts,
        error: err.message,
        delayMs: Math.min(delayMs, left),
      });
      await deps.sleep(Math.min(delayMs, left), signal);
      delayMs = Math.min(delayMs * 2, CLICKHOUSE_WAKE_MAX_DELAY_MS);
    }
  }
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

      // Waits through a serverless wake; retries cold starts otherwise.
      const client = await connectClickHouse(database, config);
      await client.close();

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

      // Retry only connection establishment (and a serverless wake), never the
      // query: re-running an INSERT or ALTER would duplicate its side effects.
      const client = await connectClickHouse(
        database,
        config,
        abortController.signal,
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

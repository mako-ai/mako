/**
 * SQL for workflow code (lib/mako `query()` and `execute()`): the rows
 * themselves, as the driver returns them, never cut and never formatted for
 * a model.
 *
 * A statement runs exactly once. Its result is read whole, up to a cap
 * counted while it is read (rows and bytes): past the cap the read stops and
 * the query fails, so one call cannot hold an unbounded result in memory.
 * A per-call timeout cancels the statement on the database.
 *
 * A query passes the same checks as the agent's `sql_execute_query`
 * (resolveSqlQueryTarget: the key's query access, the connection's writers
 * list for the workflow or person acting) and is recorded the same way. A
 * write's `rowCount` is the rows it changed.
 */
import { randomUUID } from "node:crypto";

import { isWrite } from "../access/connection-writes";
import type { QueryAccess } from "../auth/api-key-scopes";
import {
  resolveSqlQueryTarget,
  trackSqlExecution,
} from "../agent-lib/tools/sql-tools";
import {
  isAgentToolAbortError,
  isAgentToolTimeoutError,
  withAgentTimeout,
} from "../agent-lib/tools/shared/truncation";
import { databaseConnectionService } from "../services/database-connection.service";

/** The most rows one query may return; `maxRows` lowers it. */
export const WORKFLOW_QUERY_MAX_ROWS = 100_000;
/** The most bytes (as JSON) one query may return. */
export const WORKFLOW_QUERY_MAX_BYTES = 50 * 1024 * 1024;
export const WORKFLOW_QUERY_DEFAULT_TIMEOUT_MS = 5 * 60_000;
export const WORKFLOW_QUERY_MAX_TIMEOUT_MS = 15 * 60_000;

export interface WorkflowQueryInput {
  connectionId: string;
  query: string;
  database?: string;
  maxRows?: number;
  timeoutMs?: number;
}

export interface WorkflowQueryResult {
  rows: unknown[];
  fields: Array<{ name: string; type?: string }>;
  /** Rows returned for a read; rows changed for a write. */
  rowCount: number;
}

/** Why a query did not run or did not finish, as the workflow is told. */
export class WorkflowQueryError extends Error {}

function plainFields(fields: unknown): WorkflowQueryResult["fields"] {
  if (!Array.isArray(fields)) return [];
  return fields.map(field => {
    const { name, type } = field as { name?: unknown; type?: unknown };
    return {
      name: String(name),
      ...(typeof type === "string" ? { type } : {}),
    };
  });
}

/** A row's size as the response will carry it. */
function jsonBytes(row: unknown): number {
  return Buffer.byteLength(
    JSON.stringify(row, (_key, value) =>
      typeof value === "bigint" ? value.toString() : value,
    ) ?? "",
  );
}

export async function runWorkflowQuery(
  worker: { workspaceId: string; userId: string; queryAccess: QueryAccess },
  input: WorkflowQueryInput,
  signal?: AbortSignal,
): Promise<WorkflowQueryResult> {
  const startTime = Date.now();
  const target = await resolveSqlQueryTarget(
    input.connectionId,
    input.database,
    input.query,
    worker.workspaceId,
    worker.queryAccess,
  ).catch(error => {
    throw new WorkflowQueryError(
      error instanceof Error ? error.message : String(error),
    );
  });
  const { database, options } = target;
  const maxRows = input.maxRows ?? WORKFLOW_QUERY_MAX_ROWS;
  const timeoutMs = input.timeoutMs ?? WORKFLOW_QUERY_DEFAULT_TIMEOUT_MS;
  // A write's rows (RETURNING) are not capped: it already ran, and failing
  // it would invite running it again.
  const capped = !isWrite(database.type, input.query);
  let rows = 0;
  let bytes = 0;
  const onRows = (batch: Record<string, unknown>[]) => {
    if (!capped) return;
    rows += batch.length;
    for (const row of batch) bytes += jsonBytes(row);
    if (rows > maxRows || bytes > WORKFLOW_QUERY_MAX_BYTES) {
      throw new Error(
        rows > maxRows
          ? `The result has more than ${maxRows} rows. Aggregate or filter in SQL, or read it in parts (e.g. by id range).`
          : `The result is over ${WORKFLOW_QUERY_MAX_BYTES / 1024 / 1024} MB. Aggregate or filter in SQL, select fewer columns, or read it in parts (e.g. by id range).`,
      );
    }
  };

  const executionId = `workflow-query-${randomUUID()}`;
  const result = await withAgentTimeout(
    executionId,
    id =>
      databaseConnectionService.executeQueryReadingRows(database, input.query, {
        ...options,
        executionId: id,
        signal,
        readOnly: target.readOnly,
        timeoutMs,
        onRows,
      }),
    { signal, timeoutMs },
  ).catch(error => {
    if (isAgentToolTimeoutError(error)) {
      const failed = { success: false, error: "timeout" };
      trackSqlExecution({
        userId: worker.userId,
        workspaceId: worker.workspaceId,
        target,
        source: "agent",
        result: failed,
        startTime,
      });
      throw new WorkflowQueryError(
        `The query did not finish within ${timeoutMs / 1000}s and was cancelled. Make it cheaper, or pass a longer timeoutMs (up to ${WORKFLOW_QUERY_MAX_TIMEOUT_MS / 1000}s).`,
      );
    }
    if (isAgentToolAbortError(error)) {
      throw new WorkflowQueryError("The query was cancelled");
    }
    throw error;
  });
  trackSqlExecution({
    userId: worker.userId,
    workspaceId: worker.workspaceId,
    target,
    source: "agent",
    result,
    startTime,
  });
  if (!result.success) {
    throw new WorkflowQueryError(result.error ?? "The query failed");
  }
  const data = Array.isArray(result.data)
    ? result.data
    : result.data == null
      ? []
      : [result.data];
  return {
    rows: data,
    fields: plainFields(result.fields),
    rowCount: result.rowCount ?? data.length,
  };
}

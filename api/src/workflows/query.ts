/**
 * SQL for workflow code (lib/mako `query()`): the rows themselves, as the
 * driver returns them, never cut and never formatted for a model.
 *
 * A query passes the same checks as the agent's `sql_execute_query`
 * (resolveSqlQueryTarget: the key's query access, the connection's writers
 * list for the workflow or person acting) and is recorded the same way. A
 * read is paged: at most `maxRows` rows per request, and `nextCursor` for
 * the next page, so one call cannot hold an unbounded result in memory. A
 * write, or a statement that cannot be wrapped in a page (SHOW, EXPLAIN),
 * runs once as written; a write's `rowCount` is the rows it changed.
 */
import { isWrite } from "../access/connection-writes";
import type { QueryAccess } from "../auth/api-key-scopes";
import {
  resolveSqlQueryTarget,
  trackSqlExecution,
} from "../agent-lib/tools/sql-tools";
import { databaseConnectionService } from "../services/database-connection.service";
import {
  MAX_PREVIEW_PAGE_SIZE,
  stripLeadingSqlComments,
} from "../services/query-pagination.service";

/** Rows per page, and the most a request may ask for. */
export const WORKFLOW_QUERY_MAX_ROWS = MAX_PREVIEW_PAGE_SIZE;

export interface WorkflowQueryInput {
  connectionId: string;
  query: string;
  database?: string;
  cursor?: string;
  maxRows?: number;
}

export interface WorkflowQueryResult {
  rows: unknown[];
  fields: Array<{ name: string; type?: string }>;
  /** Rows in this page for a read; rows changed for a write. */
  rowCount: number;
  /** Pass back as `cursor` for the next page; absent on the last one. */
  nextCursor?: string;
}

/** Why a query did not run, as the workflow should be told. */
export class WorkflowQueryError extends Error {}

/** A SELECT or WITH: a result that can be read a page at a time. */
function isPageable(query: string): boolean {
  return /^[\s(]*(select|with)\b/i.test(stripLeadingSqlComments(query.trim()));
}

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
  const track = (result: {
    success: boolean;
    error?: string;
    rowCount?: number;
  }) =>
    trackSqlExecution({
      userId: worker.userId,
      workspaceId: worker.workspaceId,
      target,
      source: "agent",
      result,
      startTime,
    });

  if (isWrite(database.type, input.query) || !isPageable(input.query)) {
    if (input.cursor) {
      throw new WorkflowQueryError("Only a SELECT or WITH query has pages");
    }
    const result = await databaseConnectionService.executeQuery(
      database,
      input.query,
      { ...options, signal, readOnly: target.readOnly },
    );
    track(result);
    if (!result.success) {
      throw new WorkflowQueryError(result.error ?? "The query failed");
    }
    const rows = Array.isArray(result.data)
      ? result.data
      : result.data == null
        ? []
        : [result.data];
    return {
      rows,
      fields: plainFields(result.fields),
      rowCount: result.rowCount ?? rows.length,
    };
  }

  const result = await databaseConnectionService.executePreviewQuery(
    database,
    input.query,
    {
      ...options,
      signal,
      pageSize: input.maxRows,
      cursor: input.cursor ?? null,
      // On BigQuery, read-only is only the text check, which isWrite made
      // above; it would also turn off BigQuery's own result pages.
      readOnly: target.readOnly && database.type !== "bigquery",
    },
  );
  track(result);
  if (!result.success) {
    throw new WorkflowQueryError(result.error ?? "The query failed");
  }
  const rows = result.rows ?? [];
  const nextCursor = result.pageInfo?.nextCursor;
  return {
    rows,
    fields: plainFields(result.fields),
    rowCount: rows.length,
    ...(nextCursor ? { nextCursor } : {}),
  };
}

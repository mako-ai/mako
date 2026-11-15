import type { MakoChartSpec } from "../../lib/chart-spec";
import type { ConsoleTab } from "../../store/lib/types";
import type {
  ConsoleResultsContext,
  ExecuteOptions,
  QueryPageInfo,
  QueryResult,
  ResultsViewMode,
  SaveDialogMode,
  TabPaginationState,
} from "./types";

export const DEFAULT_PAGE_SIZE = 500;

/**
 * Snapshot of the active tab's results that Chat reads at request time
 * (columns, a few sample rows, the current view/chart).
 */
export function buildResultsContext(
  result: QueryResult | null | undefined,
  viewMode: ResultsViewMode,
  chartSpec: MakoChartSpec | null,
): ConsoleResultsContext {
  if (!result || !result.results) {
    return {
      viewMode,
      chartSpec,
      hasResults: false,
      rowCount: 0,
      columns: [],
      sampleRows: [],
    };
  }

  const rows = Array.isArray(result.results)
    ? result.results
    : [result.results];
  const columns: string[] = [];
  if (result.fields && Array.isArray(result.fields)) {
    for (const f of result.fields) {
      const name = typeof f === "string" ? f : f?.name;
      if (name) columns.push(name);
    }
  }
  if (
    columns.length === 0 &&
    rows.length > 0 &&
    typeof rows[0] === "object" &&
    rows[0]
  ) {
    columns.push(...Object.keys(rows[0]));
  }

  return {
    viewMode,
    chartSpec,
    hasResults: true,
    rowCount: rows.length,
    columns,
    sampleRows: rows.slice(0, 5),
  };
}

/**
 * Persisted server-side run artifact (tab.lastRun) -> results panel.
 *
 * Returns the result to show, or `null` to keep what is shown. Two cases,
 * both driven by the revision sync that keeps tab.lastRun fresh:
 *   1. Detached return: a console opened with a persisted artifact (the agent
 *      ran it while no window was attached) renders results without re-running.
 *   2. Missed live event catch-up: the agent ran the console while this window
 *      was backgrounded/disconnected, so the ephemeral console.run.completed
 *      event never landed — but the reconnect sync refreshed tab.lastRun. Show
 *      the newer agent run instead of leaving stale results on screen.
 *
 * In-memory results from a LOCAL run always win: they hold the full row set
 * while the artifact is capped (~50 rows), so we only override a displayed
 * result (`shown !== undefined`) for AGENT runs strictly newer than it.
 */
export function resultFromLastRun(
  lastRun: ConsoleTab["lastRun"],
  shown: QueryResult | null | undefined,
): QueryResult | null {
  if (!lastRun || lastRun.status !== "success" || !lastRun.sampleRows) {
    return null;
  }
  const lastRunAt = new Date(lastRun.at).getTime();
  if (shown !== undefined) {
    const shownAt = shown?.executedAt
      ? new Date(shown.executedAt).getTime()
      : NaN;
    if (lastRun.source !== "agent" || !(lastRunAt > shownAt)) {
      return null;
    }
  }
  return {
    results: lastRun.sampleRows ?? [],
    executedAt: lastRun.at,
    resultCount: lastRun.rowCount ?? lastRun.sampleRows?.length ?? 0,
    executionTime: lastRun.durationMs,
    fields: (lastRun.fields as QueryResult["fields"]) ?? null,
    pageInfo: null,
  } as QueryResult;
}

/** Pagination state after a successful page fetch. */
export function paginationFromPage(
  pageInfo: QueryPageInfo | null | undefined,
  options: ExecuteOptions | undefined,
): TabPaginationState {
  return {
    currentPage: options?.currentPage ?? 1,
    cursorHistory: options?.cursorHistory ?? [null],
    nextCursor: pageInfo?.nextCursor ?? null,
    hasMore: pageInfo?.hasMore ?? false,
    pageSize: pageInfo?.pageSize ?? options?.pageSize ?? DEFAULT_PAGE_SIZE,
    capApplied: pageInfo?.capApplied ?? false,
  };
}

type PageTab = Pick<ConsoleTab, "databaseId" | "databaseName">;

/** Execute options for the next results page, or null when there is none. */
export function nextPageOptions(
  tab: PageTab,
  pagination: TabPaginationState | null | undefined,
): ExecuteOptions | null {
  if (!pagination?.nextCursor) return null;
  return {
    databaseId: tab.databaseId,
    databaseName: tab.databaseName,
    cursor: pagination.nextCursor,
    currentPage: pagination.currentPage + 1,
    cursorHistory: [...pagination.cursorHistory, pagination.nextCursor],
    pageSize: pagination.pageSize,
  };
}

/** Execute options for the previous results page, or null on page 1. */
export function previousPageOptions(
  tab: PageTab,
  pagination: TabPaginationState | null | undefined,
): ExecuteOptions | null {
  if (!pagination || pagination.currentPage <= 1) return null;
  const previousHistory = pagination.cursorHistory.slice(0, -1);
  const previousCursor = previousHistory[previousHistory.length - 1] ?? null;
  return {
    databaseId: tab.databaseId,
    databaseName: tab.databaseName,
    cursor: previousCursor,
    currentPage: pagination.currentPage - 1,
    cursorHistory: previousHistory.length > 0 ? previousHistory : [null],
    pageSize: pagination.pageSize,
  };
}

/** Name pre-filled in the save dialog for each save flow. */
export function saveDialogDefaultName(
  tab: Pick<ConsoleTab, "filePath" | "title"> | undefined,
  mode: SaveDialogMode,
): string {
  if (!tab) return "";
  if (mode === "save-as-copy") {
    const base = tab.filePath || tab.title || "";
    return base ? `${base} (copy)` : "";
  }
  if (mode === "rename-move") {
    return tab.filePath || tab.title || "";
  }
  return tab.title || "";
}

/** Shallow-immutable delete of one key (no-op copy when absent). */
export function omitKey<T>(
  record: Record<string, T>,
  key: string,
): Record<string, T> {
  const next = { ...record };
  delete next[key];
  return next;
}

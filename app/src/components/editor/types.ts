import type { MakoChartSpec } from "../../lib/chart-spec";

export interface QueryPageInfo {
  pageSize: number;
  hasMore: boolean;
  nextCursor: string | null;
  returnedRows: number;
  capApplied: boolean;
}

export interface QueryResult {
  results: any[];
  executedAt: string;
  resultCount: number;
  executionTime?: number;
  fields?: Array<{ name?: string; originalName?: string } | string>;
  pageInfo?: QueryPageInfo | null;
  currentPage?: number;
}

export interface TabPaginationState {
  currentPage: number;
  cursorHistory: Array<string | null>;
  nextCursor: string | null;
  hasMore: boolean;
  pageSize: number;
  capApplied: boolean;
}

export type ResultsViewMode = "table" | "json" | "chart";

export interface ChartSpecChangePayload {
  spec: MakoChartSpec;
  onRenderResult?: (result: { success: boolean; error?: string }) => void;
}

export interface ConsoleResultsContext {
  viewMode: ResultsViewMode;
  chartSpec: MakoChartSpec | null;
  hasResults: boolean;
  rowCount: number;
  columns: string[];
  sampleRows: Record<string, unknown>[];
}

/** Options threaded through a console execution (pagination + safety). */
export interface ExecuteOptions {
  databaseId?: string;
  databaseName?: string;
  cursor?: string | null;
  currentPage?: number;
  cursorHistory?: Array<string | null>;
  pageSize?: number;
  confirmUnsafe?: boolean;
}

/** A PREVIEW_BLOCKED run the admin may re-run with confirmUnsafe. */
export interface PreviewRetry {
  tabId: string;
  contentToExecute: string;
  connectionId: string;
  options?: Omit<ExecuteOptions, "confirmUnsafe">;
}

export type BottomPanel = "results" | "runs";
export type SaveDialogMode = "new" | "save-as-copy" | "rename-move";

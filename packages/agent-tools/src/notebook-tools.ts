/**
 * Client-side notebook agent tools.
 *
 * Like the app/dashboard tools, these have no `execute` function, so the AI SDK
 * routes them to the browser via `onToolCall`, where `executeNotebookAgentTool`
 * applies them to the open notebook (via `notebookStore`) and returns a result.
 * Edits autosave through the notebook CRUD API, so agent and human edits share
 * one document.
 */
import { tool } from "ai";
import { z } from "zod";
import {
  appResourceVersion,
  appVersionedResourceVersion,
  readAppResourceRange,
  searchAppResources,
} from "./app-tools";

export const NOTEBOOK_SOURCE_PREVIEW_CHARS = 160;
export const NOTEBOOK_CELL_PAGE_LIMIT = 100;

export const notebookIdField = z
  .string()
  .optional()
  .describe("Notebook id. Defaults to the notebook in the active tab.");

export const cellTypeField = z
  .enum(["code", "sql", "markdown"])
  .describe(
    "Cell type: 'sql' runs against a data source, 'code' is Python (runs on " +
      "the managed kernel), 'markdown' renders as prose.",
  );

export const readNotebookSchema = z.object({
  notebookId: notebookIdField,
  cellOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Cell offset (default 0)."),
  cellLimit: z
    .number()
    .int()
    .min(1)
    .max(NOTEBOOK_CELL_PAGE_LIMIT)
    .optional()
    .describe(
      `Maximum cells to return (default 50, max ${NOTEBOOK_CELL_PAGE_LIMIT}).`,
    ),
});

export const searchNotebookSchema = z.object({
  notebookId: notebookIdField,
  query: z
    .string()
    .min(1)
    .describe("Case-insensitive text to find in cell sources."),
  cellTypes: z
    .array(cellTypeField)
    .optional()
    .describe("Optional cell types to search; defaults to all types."),
  contextLines: z.number().int().min(0).max(10).optional(),
  maxResults: z.number().int().min(1).max(50).optional(),
  offset: z.number().int().min(0).optional(),
});

export const readNotebookCellSchema = z.object({
  notebookId: notebookIdField,
  cellId: z.string().describe("Cell id from read_notebook or search_notebook."),
  startLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("First line (1-based)."),
  endLine: z
    .number()
    .int()
    .min(1)
    .optional()
    .describe("Last line (inclusive)."),
  startOffset: z
    .number()
    .int()
    .min(0)
    .optional()
    .describe("Character offset continuation for an oversized single line."),
});

export const editNotebookCellSchema = z
  .object({
    notebookId: notebookIdField,
    cellId: z.string().describe("Cell id from read_notebook"),
    source: z
      .string()
      .optional()
      .describe(
        "Replace the full source. Prefer oldString/newString for large cells.",
      ),
    oldString: z
      .string()
      .optional()
      .describe(
        "Unique source text to replace without resending the full cell.",
      ),
    newString: z.string().optional().describe("Replacement for oldString."),
    replaceAll: z
      .boolean()
      .optional()
      .describe("Replace every occurrence of oldString (default false)."),
    resourceVersion: z
      .string()
      .optional()
      .describe(
        "Version from read_notebook, search_notebook, or read_notebook_cell. " +
          "The edit is rejected if the cell changed since it was read.",
      ),
    type: cellTypeField.optional(),
    connectionId: z.string().optional(),
  })
  .superRefine((value, ctx) => {
    const hasTargetedEdit =
      value.oldString !== undefined || value.newString !== undefined;
    if (
      hasTargetedEdit &&
      (value.oldString === undefined || value.newString === undefined)
    ) {
      ctx.addIssue({
        code: "custom",
        message: "oldString and newString must be provided together",
      });
    }
    if (hasTargetedEdit && value.source !== undefined) {
      ctx.addIssue({
        code: "custom",
        message: "Use either source or oldString/newString, not both",
      });
    }
  });

export function notebookCellResourceVersion(
  cell: {
    source?: string | null;
    type?: string | null;
    connectionId?: string | null;
  },
  notebookVersion?: number,
): string {
  const resourceVersion = appResourceVersion(
    JSON.stringify({
      source: cell.source ?? "",
      type: cell.type ?? "code",
      connectionId: cell.connectionId ?? null,
    }),
  );
  return notebookVersion === undefined
    ? resourceVersion
    : appVersionedResourceVersion(notebookVersion, resourceVersion);
}

export function summarizeNotebookCell(
  cell: {
    id: string;
    source?: string | null;
    type?: string | null;
    connectionId?: string | null;
    outputs?: unknown[] | null;
    executionCount?: number | null;
    executedAt?: string | null;
  },
  notebookVersion?: number,
) {
  const source = cell.source ?? "";
  return {
    cellId: cell.id,
    type: cell.type ?? "code",
    connectionId: cell.connectionId,
    sourceLength: source.length,
    sourcePreview:
      source.length <= NOTEBOOK_SOURCE_PREVIEW_CHARS
        ? source
        : `${source.slice(0, NOTEBOOK_SOURCE_PREVIEW_CHARS)}…`,
    lines: source.split("\n").length,
    resourceVersion: notebookCellResourceVersion(cell, notebookVersion),
    outputCount: cell.outputs?.length ?? 0,
    executionCount: cell.executionCount,
    executedAt: cell.executedAt,
  };
}

export const readNotebookCellRange = readAppResourceRange;

export function searchNotebookCells(
  cells: Array<{
    id: string;
    source?: string | null;
    type?: string | null;
    connectionId?: string | null;
  }>,
  query: string,
  options?: {
    cellTypes?: Array<"code" | "sql" | "markdown">;
    contextLines?: number;
    maxResults?: number;
    offset?: number;
    notebookVersion?: number;
  },
) {
  const allowed = new Set(options?.cellTypes ?? ["code", "sql", "markdown"]);
  const result = searchAppResources(
    cells
      .filter(cell =>
        allowed.has((cell.type ?? "code") as "code" | "sql" | "markdown"),
      )
      .map(cell => ({
        resource: `cell:${cell.id}`,
        kind: "cell" as const,
        name: cell.id,
        text: cell.source ?? "",
        resourceVersion: notebookCellResourceVersion(
          cell,
          options?.notebookVersion,
        ),
      })),
    query,
    options,
  );
  return {
    ...result,
    matches: result.matches.map(match => ({
      cellId: match.name,
      line: match.line,
      startLine: match.startLine,
      endLine: match.endLine,
      snippet: match.snippet,
      resourceVersion: match.resourceVersion,
    })),
  };
}

export const clientNotebookTools = {
  create_notebook: tool({
    description:
      "Create a new notebook, open it in a tab, and make it the active " +
      "notebook. Use this first when no notebook is open (or the user asks " +
      "for a new one); subsequent cell tools then default to it.",
    inputSchema: z.object({
      name: z
        .string()
        .optional()
        .describe("Notebook title. Defaults to 'Untitled notebook'."),
    }),
  }),
  list_open_notebooks: tool({
    description:
      "List notebooks currently open in a tab (id, title, cell count). Use to " +
      "find the notebook to work on before reading or editing it.",
    inputSchema: z.object({}),
  }),
  read_notebook: tool({
    description:
      "Get a compact, paginated notebook manifest: cell ids/types, source lengths " +
      "and short previews, connection ids, execution metadata, and resource versions. " +
      "Full source is intentionally omitted; use search_notebook, then " +
      "read_notebook_cell for relevant ranges.",
    inputSchema: readNotebookSchema,
  }),
  search_notebook: tool({
    description:
      "Search notebook cell sources without loading the whole notebook into " +
      "context. Returns bounded snippets, line ranges, cell ids, and versions.",
    inputSchema: searchNotebookSchema,
  }),
  read_notebook_cell: tool({
    description:
      "Read a bounded line range from one notebook cell. Returns continuation " +
      "metadata and a resourceVersion for safe targeted edits.",
    inputSchema: readNotebookCellSchema,
  }),
  add_notebook_cell: tool({
    description:
      "Append (or insert at atIndex) a cell. For a SQL cell, set connectionId " +
      "to a data source id (from list_connections) so it can run.",
    inputSchema: z.object({
      notebookId: notebookIdField,
      type: cellTypeField,
      source: z.string().optional().describe("Cell contents"),
      connectionId: z
        .string()
        .optional()
        .describe("Data source id for SQL cells"),
      atIndex: z
        .number()
        .int()
        .optional()
        .describe("Insert position; appends when omitted"),
    }),
  }),
  edit_notebook_cell: tool({
    description:
      "Edit a cell's source or metadata. For large cells, use a unique " +
      "oldString/newString plus resourceVersion instead of replacing the full source.",
    inputSchema: editNotebookCellSchema,
  }),
  delete_notebook_cell: tool({
    description: "Delete a cell by id.",
    inputSchema: z.object({
      notebookId: notebookIdField,
      cellId: z.string(),
    }),
  }),
  run_notebook_sql_cell: tool({
    description:
      "Run a SQL cell against its data source and return the columns + first " +
      "rows. The cell must be type 'sql' with a connectionId set.",
    inputSchema: z.object({
      notebookId: notebookIdField,
      cellId: z.string(),
    }),
  }),
  run_notebook_code_cell: tool({
    description:
      "Run a Python ('code') cell on the notebook's managed kernel and return " +
      "its stdout/stderr, any error + traceback, and the result. Kernel state " +
      "persists across runs (variables, imports), so cells build on each other. " +
      "pandas, polars, numpy, matplotlib, plotly, duckdb and the `mako` SDK are " +
      "preinstalled. Use after add_notebook_cell to execute + iterate: run, read " +
      "the output/error, fix the cell, rerun.",
    inputSchema: z.object({
      notebookId: notebookIdField,
      cellId: z.string(),
    }),
  }),
};

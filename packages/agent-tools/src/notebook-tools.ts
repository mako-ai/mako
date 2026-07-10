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

const notebookIdField = z
  .string()
  .optional()
  .describe("Notebook id. Defaults to the notebook in the active tab.");

const cellTypeField = z
  .enum(["code", "sql", "markdown"])
  .describe(
    "Cell type: 'sql' runs against a data source, 'code' is Python (runs on " +
      "the kernel — not available yet), 'markdown' renders as prose.",
  );

export const clientNotebookTools = {
  list_open_notebooks: tool({
    description:
      "List notebooks currently open in a tab (id, title, cell count). Use to " +
      "find the notebook to work on before reading or editing it.",
    inputSchema: z.object({}),
  }),
  read_notebook: tool({
    description:
      "Read a notebook's cells (cellId, type, source, connectionId) so you can " +
      "decide what to add, edit, or run.",
    inputSchema: z.object({ notebookId: notebookIdField }),
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
      "Replace a cell's source (and optionally its type/connectionId). Get " +
      "cellId from read_notebook.",
    inputSchema: z.object({
      notebookId: notebookIdField,
      cellId: z.string().describe("Cell id from read_notebook"),
      source: z.string().optional(),
      type: cellTypeField.optional(),
      connectionId: z.string().optional(),
    }),
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
      "rows. The cell must be type 'sql' with a connectionId set. Python cells " +
      "cannot run yet.",
    inputSchema: z.object({
      notebookId: notebookIdField,
      cellId: z.string(),
    }),
  }),
};

/**
 * Console tool schemas + the remaining client-side console tool.
 *
 * Since issue #475 the console DATA tools (read/modify/create/
 * set_connection/run/open) execute SERVER-SIDE against the authoritative
 * SavedConsole draft (api/src/agent-lib/tools/server-console-tools.ts);
 * open windows follow along via the workspace realtime channel. Their zod
 * schemas live here as the single source of truth shared between the API
 * (tool registration) and the app (tool cards / typed inputs).
 *
 * Only `list_open_consoles` remains client-side: "which tabs are open" is
 * inherently a browser question. It has no execute function, which signals
 * to the AI SDK that it is handled in the browser via onToolCall.
 */

import { tool } from "ai";
import { z } from "zod";

// Schema definitions for client-side console tools
export const modifyConsoleSchema = z.object({
  action: z
    .enum(["replace", "insert", "append", "patch"])
    .describe(
      "The type of modification to perform. Use 'patch' for small edits (<10 lines).",
    ),
  content: z.string().describe("The content to add or replace"),
  position: z
    .number()
    .nullable()
    .optional()
    .describe(
      "Line number for the 'insert' action (1-indexed). Omit or pass null for 'replace', 'append', and 'patch' actions.",
    ),
  consoleId: z
    .string()
    .describe(
      "Target console ID (required). Get IDs from list_open_consoles or create_console.",
    ),
  title: z
    .string()
    .optional()
    .describe(
      "Short descriptive title for the console (e.g. 'Monthly Revenue by Region'). " +
        "Set this when the console content changes significantly or when the current title is generic like 'New Console'.",
    ),
  startLine: z
    .number()
    .optional()
    .describe("Starting line for patch action (1-indexed, required for patch)"),
  endLine: z
    .number()
    .optional()
    .describe(
      "Ending line for patch action (1-indexed, inclusive, required for patch)",
    ),
});

export const readConsoleSchema = z.object({
  consoleId: z
    .string()
    .describe(
      "Console ID to read from (required). Get IDs from list_open_consoles.",
    ),
});

export const createConsoleSchema = z.object({
  title: z.string().describe("Title for the new console tab"),
  content: z.string().describe("Initial content for the console"),
  connectionId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Optional: DatabaseConnection ID to attach this console to (MongoDB ObjectId).",
    ),
  databaseId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Optional: sub-database ID for cluster mode (e.g., D1 UUID). Usually null.",
    ),
  databaseName: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Optional: database name to attach (e.g., MongoDB database name, Postgres database name).",
    ),
});

export const listOpenConsolesSchema = z.object({});

export const openConsoleSchema = z.object({
  consoleId: z
    .string()
    .describe("Console ID to open (from search_consoles results)."),
});

export const runConsoleSchema = z.object({
  consoleId: z
    .string()
    .describe(
      "Console ID to execute. The console must have a query and an active connection.",
    ),
});

export const checkQueryStatusSchema = z.object({
  consoleId: z
    .string()
    .describe(
      "Console ID whose latest run you want to poll (the one you called run_console on).",
    ),
  executionId: z
    .string()
    .optional()
    .describe(
      "Optional executionId returned by run_console. If set, the status is only reported when it matches the console's latest run.",
    ),
});

export const cancelQueryStatusSchema = z.object({
  consoleId: z
    .string()
    .describe("Console ID whose running query you want to cancel."),
  executionId: z
    .string()
    .describe("The executionId returned by run_console for the running query."),
});

export const listConsoleExecutionsSchema = z.object({
  consoleId: z
    .string()
    .describe(
      "Console ID whose recent execution history to list (from search_consoles / list_open_consoles).",
    ),
  limit: z
    .number()
    .int()
    .min(1)
    .max(50)
    .optional()
    .describe("Max rows to return (default 10, max 50). Retained for 90 days."),
});

export const setConsoleConnectionSchema = z.object({
  consoleId: z
    .string()
    .describe(
      "Console ID to attach (required). Get IDs from list_open_consoles or create_console.",
    ),
  connectionId: z.string().describe("Database connection ID to attach to"),
  databaseId: z
    .string()
    .optional()
    .describe(
      "Specific database ID for cluster-mode connections (e.g., D1 UUID)",
    ),
  databaseName: z
    .string()
    .optional()
    .describe(
      "Database name for connections with multiple databases (e.g., PostgreSQL, MongoDB)",
    ),
});

/**
 * Client-side console tools (no execute function = client-side execution).
 * Only the open-tabs listing remains client-side — every console DATA tool
 * executes server-side (see module header).
 */
export const clientConsoleTools = {
  list_open_consoles: tool({
    description:
      "List all open console tabs in the UI. Returns each console's id, title, connectionId, databaseName, content preview, isActive flag, access level, and readOnly status. Useful to see what the user is looking at; for the full workspace catalog use search_consoles instead.",
    inputSchema: listOpenConsolesSchema,
    // No execute function - this is a client-side tool
  }),
};

// Export schema types for client-side use
export type ModifyConsoleInput = z.infer<typeof modifyConsoleSchema>;
export type ReadConsoleInput = z.infer<typeof readConsoleSchema>;
export type CreateConsoleInput = z.infer<typeof createConsoleSchema>;
export type ListOpenConsolesInput = z.infer<typeof listOpenConsolesSchema>;
export type SetConsoleConnectionInput = z.infer<
  typeof setConsoleConnectionSchema
>;
export type OpenConsoleInput = z.infer<typeof openConsoleSchema>;
export type RunConsoleInput = z.infer<typeof runConsoleSchema>;
export type CheckQueryStatusInput = z.infer<typeof checkQueryStatusSchema>;
export type CancelQueryStatusInput = z.infer<typeof cancelQueryStatusSchema>;
export type ListConsoleExecutionsInput = z.infer<
  typeof listConsoleExecutionsSchema
>;

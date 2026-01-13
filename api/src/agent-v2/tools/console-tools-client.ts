/**
 * Client-Side Console Tools for Agent V3
 *
 * These tools are designed to be executed on the client-side via the AI SDK's
 * onToolCall callback. They do NOT have execute functions, which signals to
 * the AI SDK that they should be handled client-side.
 *
 * The client will:
 * 1. Receive the tool call
 * 2. Execute the operation locally (read/modify/create consoles)
 * 3. Call addToolOutput to provide the result
 *
 * This approach is more responsive and accurate since the client has the
 * actual current state of the consoles.
 */

import { z } from "zod";

// Schema definitions for client-side console tools
export const modifyConsoleSchema = z.object({
  action: z
    .enum(["replace", "insert", "append"])
    .describe("The type of modification to perform"),
  content: z.string().describe("The content to add or replace"),
  position: z
    .number()
    .nullable()
    .describe("Position for insert action (null for replace/append)"),
  consoleId: z
    .string()
    .describe(
      "Target console ID (required). Get IDs from list_open_consoles or create_console.",
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
 * Client-side console tools (no execute function = client-side execution)
 */
export const clientConsoleTools = {
  read_console: {
    description:
      "Read the contents of a specific console by ID. Returns console content and the attached database connection information (connectionId, connectionType, databaseId, databaseName). Use list_open_consoles first to get available console IDs.",
    inputSchema: readConsoleSchema,
    // No execute function - this is a client-side tool
  },

  modify_console: {
    description:
      "Modify a specific console's content by ID. Use this to write, replace, or append code. Get the consoleId from list_open_consoles or create_console.",
    inputSchema: modifyConsoleSchema,
    // No execute function - this is a client-side tool
  },

  create_console: {
    description:
      "Create a new console editor tab with the specified content. Returns a consoleId that you MUST pass to modify_console when writing to this new console.",
    inputSchema: createConsoleSchema,
    // No execute function - this is a client-side tool
  },

  list_open_consoles: {
    description:
      "List all open console tabs in the UI. Returns each console's id, title, connectionId, databaseName, content preview, and isActive flag. Call this FIRST to get console IDs before using read_console or modify_console.",
    inputSchema: listOpenConsolesSchema,
    // No execute function - this is a client-side tool
  },

  set_console_connection: {
    description:
      "Attach a console to a database connection, or change its current attachment. Use this when you need to run queries against a different database than what the console is currently attached to. After setting the connection, you can use the console to execute queries against that database.",
    inputSchema: setConsoleConnectionSchema,
    // No execute function - this is a client-side tool
  },
};

// Export schema types for client-side use
export type ModifyConsoleInput = z.infer<typeof modifyConsoleSchema>;
export type ReadConsoleInput = z.infer<typeof readConsoleSchema>;
export type CreateConsoleInput = z.infer<typeof createConsoleSchema>;
export type ListOpenConsolesInput = z.infer<typeof listOpenConsolesSchema>;
export type SetConsoleConnectionInput = z.infer<
  typeof setConsoleConnectionSchema
>;

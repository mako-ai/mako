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
    .nullable()
    .optional()
    .describe(
      "Target console ID. Required when modifying a newly created console - use the consoleId returned by create_console.",
    ),
});

export const readConsoleSchema = z.object({
  consoleId: z
    .string()
    .nullable()
    .optional()
    .describe(
      "Console ID to read from (null/undefined to read the active console)",
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

/**
 * Client-side console tools (no execute function = client-side execution)
 */
export const clientConsoleTools = {
  read_console: {
    description:
      "Read the contents of the current console editor. Returns console content and the attached database connection information (connectionId, connectionType, databaseId, databaseName) so you know which database to query.",
    inputSchema: readConsoleSchema,
    // No execute function - this is a client-side tool
  },

  modify_console: {
    description:
      "Modify the console editor content. Use this to write, replace, or append code to the user's active console. If you just created a console with create_console, you MUST pass the returned consoleId here.",
    inputSchema: modifyConsoleSchema,
    // No execute function - this is a client-side tool
  },

  create_console: {
    description:
      "Create a new console editor tab with the specified content. Returns a consoleId that you MUST pass to modify_console when writing to this new console.",
    inputSchema: createConsoleSchema,
    // No execute function - this is a client-side tool
  },
};

// Export schema types for client-side use
export type ModifyConsoleInput = z.infer<typeof modifyConsoleSchema>;
export type ReadConsoleInput = z.infer<typeof readConsoleSchema>;
export type CreateConsoleInput = z.infer<typeof createConsoleSchema>;

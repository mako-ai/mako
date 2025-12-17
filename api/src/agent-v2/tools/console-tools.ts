/**
 * Console Tools for Agent V2
 * Using plain tool definitions to avoid complex type inference
 */

import { z } from "zod";
import type {
  ConsoleDataV2,
  ConsoleModificationResult,
  ConsoleCreationResult,
  ReadConsoleResult,
} from "../types";

// Define schemas separately to avoid inline inference overhead
const modifyConsoleSchema = z.object({
  action: z
    .enum(["replace", "insert", "append"])
    .describe("The type of modification to perform"),
  content: z.string().describe("The content to add or replace"),
  position: z
    .number()
    .nullable()
    .describe("Position for insert action (null for replace/append)"),
});

const readConsoleSchema = z.object({
  consoleId: z
    .string()
    .nullable()
    .describe("Console ID to read from (null to read the active console)"),
});

const createConsoleSchema = z.object({
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

export const createConsoleToolsV2 = (
  consoles: ConsoleDataV2[],
  preferredConsoleId?: string,
) => ({
  modify_console: {
    description:
      "Modify the console editor content. Use this to write, replace, or append code to the user's active console.",
    inputSchema: modifyConsoleSchema,
    execute: async (input: {
      action: "replace" | "insert" | "append";
      content: string;
      position: number | null;
    }): Promise<ConsoleModificationResult> => {
      const { action, content, position } = input;

      // If the client has no real consoles open, we cannot safely modify anything.
      // Return a structured failure so the model can call `create_console` first.
      if (!consoles || consoles.length === 0) {
        return {
          success: false,
          error:
            "No console is currently open. Call create_console first, then write the final query there.",
        };
      }

      if (
        action === "insert" &&
        (position === undefined || position === null)
      ) {
        throw new Error("position is required when action is set to 'insert'");
      }

      return {
        success: true,
        _eventType: "console_modification",
        modification: {
          action,
          content,
          position: position ?? undefined,
        },
        // Prefer pinned console, otherwise fall back to the first provided console
        consoleId: preferredConsoleId ?? consoles[0]?.id,
        message: `✓ Console ${action}d successfully`,
      };
    },
  },

  read_console: {
    description:
      "Read the contents of the current console editor. Returns console content and the attached database connection information (connectionId, connectionType, databaseId, databaseName) so you know which database to query.",
    inputSchema: readConsoleSchema,
    execute: async (input: {
      consoleId: string | null;
    }): Promise<ReadConsoleResult> => {
      const { consoleId } = input;
      const targetId = consoleId ?? preferredConsoleId;
      const consoleData = targetId
        ? consoles.find(c => c.id === targetId)
        : consoles[0];

      if (!consoleData) {
        return {
          success: false,
          error: targetId
            ? `Console with ID ${targetId} not found`
            : "No console is currently active",
        };
      }

      return {
        success: true,
        consoleId: consoleData.id,
        title: consoleData.title,
        content: consoleData.content || "",
        connectionId: consoleData.connectionId,
        connectionType: consoleData.connectionType,
        databaseId: consoleData.databaseId,
        databaseName: consoleData.databaseName,
      };
    },
  },

  create_console: {
    description: "Create a new console editor tab with the specified content.",
    inputSchema: createConsoleSchema,
    execute: async (input: {
      title: string;
      content: string;
      connectionId?: string | null;
      databaseId?: string | null;
      databaseName?: string | null;
    }): Promise<ConsoleCreationResult> => {
      const { title, content } = input;
      const newConsoleId = `console-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // If not explicitly provided, inherit connection context from the active/preferred console.
      const baseConsole =
        (preferredConsoleId
          ? consoles.find(c => c.id === preferredConsoleId)
          : undefined) ?? consoles[0];

      const effectiveConnectionId =
        input.connectionId ?? baseConsole?.connectionId ?? undefined;
      const effectiveDatabaseId =
        input.databaseId ?? baseConsole?.databaseId ?? undefined;
      const effectiveDatabaseName =
        input.databaseName ?? baseConsole?.databaseName ?? undefined;

      return {
        success: true,
        _eventType: "console_creation",
        consoleId: newConsoleId,
        title,
        content,
        connectionId: effectiveConnectionId || undefined,
        databaseId: effectiveDatabaseId || undefined,
        databaseName: effectiveDatabaseName || undefined,
        message: `✓ New console "${title}" created successfully`,
      };
    },
  },
});

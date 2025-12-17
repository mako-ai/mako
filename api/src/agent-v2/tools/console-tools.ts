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
        consoleId: preferredConsoleId,
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
    }): Promise<ConsoleCreationResult> => {
      const { title, content } = input;
      const newConsoleId = `console-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      return {
        success: true,
        _eventType: "console_creation",
        consoleId: newConsoleId,
        title,
        content,
        message: `✓ New console "${title}" created successfully`,
      };
    },
  },
});

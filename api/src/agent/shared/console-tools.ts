// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – provided at runtime
import { tool } from "@openai/agents";

export interface ConsoleModification {
  action: "replace" | "insert" | "append";
  content: string;
  position?: number;
}

export interface ConsoleData {
  id: string;
  title: string;
  content: string;
  metadata?: Record<string, any>;
}

export interface ConsoleEvent {
  type: "console_modification";
  modification: ConsoleModification;
}

export type SendEventFunction = (data: ConsoleEvent) => void;

export const createConsoleTools = (
  consoles?: ConsoleData[],
  preferredConsoleId?: string,
) => {
  const modifyConsoleTool = tool({
    name: "modify_console",
    description: "Modify the console editor content.",
    parameters: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["replace", "insert", "append"],
          description: "The type of modification to perform",
        },
        content: {
          type: "string",
          description: "The content to add or replace",
        },
        position: {
          type: ["number", "null"],
          description: "Position for insert action (null for replace/append)",
        },
      },
      required: ["action", "content", "position"],
      additionalProperties: false,
    },
    execute: async (input: unknown) => {
      const typedInput = input as {
        action: "replace" | "insert" | "append";
        content: string;
        position?: number | null;
      };

      if (
        typedInput.action === "insert" &&
        (typedInput.position === undefined || typedInput.position === null)
      ) {
        throw new Error(
          "position is required when action is set to 'insert'",
        );
      }

      const modification: ConsoleModification = {
        action: typedInput.action,
        content: typedInput.content,
        position:
          typedInput.position === null || typedInput.position === undefined
            ? undefined
            : typedInput.position,
      };

      // Return the modification data so the stream handler can send events
      return {
        success: true,
        modification,
        consoleId: preferredConsoleId,
        message: `✓ Console ${typedInput.action}d successfully`,
        _eventType: "console_modification", // Marker for stream handler
      };
    },
  });

  const readConsoleTool = tool({
    name: "read_console",
    description: "Read the contents of the current console editor.",
    parameters: {
      type: "object",
      properties: {
        consoleId: {
          type: ["string", "null"],
          description:
            "Console ID to read from (null to read the active console)",
        },
      },
      required: ["consoleId"],
      additionalProperties: false,
    },
    execute: async (input: unknown) => {
      const typedInput = input as { consoleId: string | null };
      const consolesData = consoles || [];
      const consoleId =
        typedInput.consoleId === null ? undefined : typedInput.consoleId;

      // Use explicit consoleId if provided
      if (consoleId) {
        const console = consolesData.find(c => c.id === consoleId);
        if (!console) {
          return {
            success: false,
            error: `Console with ID ${consoleId} not found`,
          };
        }
        return {
          success: true,
          consoleId: console.id,
          title: console.title,
          content: console.content || "",
          connectionId: console.metadata?.connectionId,
          databaseId: console.metadata?.databaseId,
          metadata: console.metadata || {},
        };
      }

      // Otherwise, use preferred console ID if available
      if (preferredConsoleId) {
        const preferredConsole = consolesData.find(
          c => c.id === preferredConsoleId,
        );
        if (preferredConsole) {
          return {
            success: true,
            consoleId: preferredConsole.id,
            title: preferredConsole.title,
            content: preferredConsole.content || "",
            connectionId: preferredConsole.metadata?.connectionId,
            databaseId: preferredConsole.metadata?.databaseId,
            metadata: preferredConsole.metadata || {},
          };
        }
      }

      // Fall back to the first (active) console
      if (consolesData.length > 0) {
        const activeConsole = consolesData[0];
        return {
          success: true,
          consoleId: activeConsole.id,
          title: activeConsole.title,
          content: activeConsole.content || "",
          connectionId: activeConsole.metadata?.connectionId,
          databaseId: activeConsole.metadata?.databaseId,
          metadata: activeConsole.metadata || {},
        };
      }

      return {
        success: false,
        error: "No console is currently active",
      };
    },
  });

  const createConsoleTool = tool({
    name: "create_console",
    description: "Create a new console editor tab.",
    parameters: {
      type: "object",
      properties: {
        title: {
          type: "string",
          description: "Title for the new console tab",
        },
        content: {
          type: "string",
          description: "Initial content for the console",
        },
      },
      required: ["title", "content"],
      additionalProperties: false,
    },
    execute: async (input: unknown) => {
      const typedInput = input as { title: string; content: string };

      // Generate a unique ID for the new console
      const newConsoleId = `console-${Date.now()}-${Math.random().toString(36).substr(2, 9)}`;

      // Return the creation data so the stream handler can send events
      return {
        success: true,
        consoleId: newConsoleId,
        title: typedInput.title,
        content: typedInput.content,
        message: `✓ New console "${typedInput.title}" created successfully`,
        _eventType: "console_creation", // Marker for stream handler
      };
    },
  });

  return [modifyConsoleTool, readConsoleTool, createConsoleTool];
};

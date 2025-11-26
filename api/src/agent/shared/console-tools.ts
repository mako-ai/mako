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
  // Connection context - populated when console is attached to a database connection
  connectionId?: string; // ID of the DatabaseConnection
  connectionType?: string; // "mongodb" | "postgresql" | etc.
  databaseName?: string; // Specific database name (for cluster mode connections)
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
        throw new Error("position is required when action is set to 'insert'");
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
    description:
      "Read the contents of the current console editor. Returns console content and the attached database connection information (connectionId, connectionType, databaseId, databaseName) so you know which database to query.",
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

      // Helper to build response with connection context
      const buildResponse = (consoleData: ConsoleData) => {
        // Extract connection context from console data
        // connectionId = DatabaseConnection MongoDB ObjectId (the server/connection)
        const connectionId =
          consoleData.connectionId || consoleData.metadata?.connectionId;
        const connectionType =
          consoleData.connectionType || consoleData.metadata?.connectionType;

        // databaseId = specific database ID (e.g., D1 UUID for cluster mode)
        // This is different from connectionId - connectionId is the server, databaseId is the specific DB
        // IMPORTANT: Check top-level first, then metadata, but NOT connectionId (they're different!)
        const databaseId =
          (consoleData as any).databaseId ||
          consoleData.metadata?.databaseId ||
          consoleData.metadata?.queryOptions?.databaseId;
        // databaseName = human-readable database name
        const databaseName =
          (consoleData as any).databaseName ||
          consoleData.metadata?.databaseName ||
          consoleData.metadata?.queryOptions?.databaseName ||
          consoleData.metadata?.queryOptions?.dbName ||
          consoleData.metadata?.dbName;

        // Debug log to help diagnose issues
        if (connectionId && databaseId && connectionId === databaseId) {
          console.warn(
            "[read_console] WARNING: connectionId and databaseId are the same!",
            {
              consoleId: consoleData.id,
              connectionId,
              databaseId,
              consoleData: {
                connectionId: consoleData.connectionId,
                metadataConnectionId: consoleData.metadata?.connectionId,
                topLevelDatabaseId: (consoleData as any).databaseId,
                metadataDatabaseId: consoleData.metadata?.databaseId,
                queryOptionsDatabaseId:
                  consoleData.metadata?.queryOptions?.databaseId,
              },
            },
          );
        }

        return {
          success: true,
          consoleId: consoleData.id,
          title: consoleData.title,
          content: consoleData.content || "",
          // Clean connection context
          connectionId, // DatabaseConnection ObjectId (server/connection)
          connectionType,
          databaseId, // Sub-database UUID (e.g., D1 database UUID for cluster-mode)
          databaseName, // Human-readable database name
        };
      };

      // Use explicit consoleId if provided
      if (consoleId) {
        const consoleData = consolesData.find(c => c.id === consoleId);
        if (!consoleData) {
          return {
            success: false,
            error: `Console with ID ${consoleId} not found`,
          };
        }
        return buildResponse(consoleData);
      }

      // Otherwise, use preferred console ID if available
      if (preferredConsoleId) {
        const preferredConsole = consolesData.find(
          c => c.id === preferredConsoleId,
        );
        if (preferredConsole) {
          return buildResponse(preferredConsole);
        }
      }

      // Fall back to the first (active) console
      if (consolesData.length > 0) {
        const activeConsole = consolesData[0];
        return buildResponse(activeConsole);
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

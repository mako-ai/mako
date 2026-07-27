/**
 * Agent V2 Type Definitions
 * Using Vercel AI SDK patterns
 */

/**
 * Database agent types for routing/selection
 */
export type DatabaseAgentKind = "mongo" | "bigquery" | "postgres" | "sqlite";

/**
 * All agent types including triage
 */
export type AgentKind = DatabaseAgentKind | "triage";

export interface ConsoleDataV2 {
  id: string;
  title: string;
  content: string;
  metadata?: Record<string, unknown>;
  // Connection context
  connectionId?: string;
  connectionType?: string;
  databaseId?: string;
  databaseName?: string;
}

/**
 * Conversation message format compatible with AI SDK CoreMessage
 */
export interface ConversationMessage {
  role: "user" | "assistant";
  content: string;
  toolCalls?: Array<{
    toolName: string;
    timestamp?: Date;
    status?: "started" | "completed";
    input?: unknown;
    result?: unknown;
  }>;
}

export interface StreamAgentParams {
  conversationHistory: ConversationMessage[];
  newMessage: string;
  workspaceId: string;
  consoles: ConsoleDataV2[];
  consoleId?: string;
  sessionId?: string;
  modelId?: string;
  workspaceCustomPrompt?: string;
}

export interface ConsoleModificationV2 {
  action: "replace" | "insert" | "append";
  content: string;
  position?: number;
}

export interface ToolResultBase {
  success: boolean;
  _eventType?: string;
  error?: string;
}

export interface ConsoleModificationResult extends ToolResultBase {
  _eventType?: "console_modification";
  modification?: ConsoleModificationV2;
  consoleId?: string;
  message?: string;
}

export interface ConsoleCreationResult extends ToolResultBase {
  _eventType: "console_creation";
  consoleId: string;
  title: string;
  content: string;
  connectionId?: string;
  databaseId?: string;
  databaseName?: string;
  message?: string;
}

export interface ReadConsoleResult extends ToolResultBase {
  consoleId?: string;
  title?: string;
  content?: string;
  connectionId?: string;
  connectionType?: string;
  databaseId?: string;
  databaseName?: string;
  error?: string;
}

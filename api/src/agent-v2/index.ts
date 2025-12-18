/**
 * Agent V2 Module Exports
 * Using Vercel AI SDK for improved streaming and tool handling
 */

// Types
export type {
  AgentKind,
  DatabaseAgentKind,
  ConsoleDataV2,
  StreamAgentParams,
  ConversationMessage,
  ConsoleModificationV2,
  ToolResultBase,
  ConsoleModificationResult,
  ConsoleCreationResult,
  ReadConsoleResult,
} from "./types";

// Stream handler
export { streamAgentResponse, processToolResult } from "./stream-handler";

// Tools
export { createUniversalToolsV2 } from "./tools/universal-tools";
export { createSqlToolsV2 } from "./tools/sql-tools";
export { createMongoToolsV2 } from "./tools/mongodb-tools";
export { createConsoleToolsV2 } from "./tools/console-tools";

// Prompts
export { UNIVERSAL_PROMPT_V2 } from "./prompts/universal";

// AI Models
export type { AIModel, AIProvider } from "./ai-models";
export {
  ALL_MODELS,
  getAvailableModels,
  getModelById,
  getDefaultModel,
  getConfiguredProviders,
} from "./ai-models";

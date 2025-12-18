/**
 * Agent V2 Module Exports
 * Using Vercel AI SDK for improved streaming and tool handling
 */

// Types
export type {
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

// Tools - Primary
export { createUniversalToolsV2 } from "./tools/universal-tools";
export { createSqlToolsV2 } from "./tools/sql-tools";
export { createMongoToolsV2 } from "./tools/mongodb-tools";
export { createConsoleToolsV2 } from "./tools/console-tools";

// Tools - Deprecated (kept for backwards compatibility)
export { createPostgresToolsV2 } from "./tools/postgres-tools";
export { createBigQueryToolsV2 } from "./tools/bigquery-tools";

// Prompts
export { UNIVERSAL_PROMPT_V2 } from "./prompts/universal";
export { MONGO_PROMPT_V2 } from "./prompts/mongodb";
export { POSTGRES_PROMPT_V2 } from "./prompts/postgres";
export { BIGQUERY_PROMPT_V2 } from "./prompts/bigquery";

// AI Models
export type { AIModel, AIProvider } from "./ai-models";
export {
  ALL_MODELS,
  getAvailableModels,
  getModelById,
  getDefaultModel,
  getConfiguredProviders,
} from "./ai-models";

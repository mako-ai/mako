/**
 * Agent V2 Module Exports
 * Using Vercel AI SDK for improved streaming and tool handling
 */

// Types
export type {
  AgentKindV2,
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
export {
  streamAgentResponse,
  detectAgentType,
  processToolResult,
} from "./stream-handler";

// Tools
export { createConsoleToolsV2 } from "./tools/console-tools";
export { createMongoToolsV2 } from "./tools/mongodb-tools";
export { createPostgresToolsV2 } from "./tools/postgres-tools";
export { createBigQueryToolsV2 } from "./tools/bigquery-tools";

// Prompts
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

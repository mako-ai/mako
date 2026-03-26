/**
 * Agent Module Exports
 * Using Vercel AI SDK for streaming and tool handling
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

// Tools
export { createUniversalTools } from "./tools/universal-tools";
export { createSqlToolsV2 } from "./tools/sql-tools";
export { createMongoToolsV2 } from "./tools/mongodb-tools";

// Prompts
export { UNIVERSAL_PROMPT_V2 } from "./prompts/universal";

// AI Models
export type { AIModel, AIProvider } from "./ai-models";
export {
  ALL_MODELS,
  isGatewayMode,
  getConfiguredProviders,
  getAvailableModels,
  getModelById,
  getDefaultModelId,
  getUtilityModelId,
} from "./ai-models";

// AI Gateway / Provider resolution
export { getModel, buildProviderOptions } from "./ai-gateway";

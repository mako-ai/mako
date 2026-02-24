/**
 * API Response Types
 *
 * Typed API response shapes for all endpoints.
 * Use these types to eliminate `as any` casts throughout the codebase.
 */

// ==================== Console Endpoints ====================

export interface ConsoleContentResponse {
  success: boolean;
  content: string;
  connectionId?: string;
  databaseId?: string;
  databaseName?: string;
  language?: "sql" | "javascript" | "mongodb";
  id: string;
  path?: string;
  name?: string;
  isSaved?: boolean;
}

export interface ConsoleSaveResponse {
  success: boolean;
  path?: string;
  error?: string;
  conflict?: {
    existingId: string;
    existingContent: string;
    existingName: string;
    existingLanguage?: "sql" | "javascript" | "mongodb";
    path: string;
  };
}

export interface ConsoleListItem {
  id: string;
  name: string;
  path: string;
  connectionId?: string;
  databaseId?: string;
  databaseName?: string;
  isSaved: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ConsoleListResponse {
  success: boolean;
  consoles: ConsoleListItem[];
}

export interface ConsoleDeleteResponse {
  success: boolean;
  error?: string;
}

// ==================== Query Execution Endpoints ====================

export interface QueryExecuteResponse {
  success: boolean;
  data?: unknown;
  error?: string;
  executionTime?: number;
  rowCount?: number;
}

export interface QueryCancelResponse {
  success: boolean;
  error?: string;
}

// ==================== Chat Endpoints ====================

export interface ChatMessagePart {
  type: "text" | "tool_call" | "tool_result";
  content: string;
  toolName?: string;
  toolCallId?: string;
}

export interface ChatMessage {
  id: string;
  role: "user" | "assistant";
  content: string;
  parts?: ChatMessagePart[];
  timestamp: string;
}

export interface ChatResponse {
  success: boolean;
  message?: ChatMessage;
  error?: string;
}

// ==================== Workspace Endpoints ====================

export interface WorkspaceResponse {
  success: boolean;
  workspace?: {
    id: string;
    name: string;
    slug: string;
    createdAt: string;
  };
  error?: string;
}

export interface WorkspaceListResponse {
  success: boolean;
  workspaces: Array<{
    id: string;
    name: string;
    slug: string;
    role: "owner" | "admin" | "member";
  }>;
}

// ==================== Database/Connection Endpoints ====================

export interface DatabaseConnectionResponse {
  success: boolean;
  connection?: {
    id: string;
    name: string;
    driver: string;
    host?: string;
    port?: number;
  };
  error?: string;
}

export interface DatabaseListResponse {
  success: boolean;
  databases: Array<{
    id: string;
    name: string;
  }>;
}

export interface DatabaseSchemaResponse {
  success: boolean;
  schema?: {
    tables: Array<{
      name: string;
      columns: Array<{
        name: string;
        type: string;
        nullable: boolean;
      }>;
    }>;
  };
  error?: string;
}

// ==================== Flow Endpoints ====================

export interface FlowResponse {
  success: boolean;
  flow?: {
    id: string;
    name: string;
    type: "webhook" | "scheduled";
    status: "active" | "paused" | "error";
    config: Record<string, unknown>;
  };
  error?: string;
}

export interface FlowListResponse {
  success: boolean;
  flows: Array<{
    id: string;
    name: string;
    type: "webhook" | "scheduled";
    status: "active" | "paused" | "error";
  }>;
}

export interface FlowLogEntry {
  id: string;
  flowId: string;
  status: "success" | "error" | "running";
  startedAt: string;
  completedAt?: string;
  error?: string;
}

export interface FlowLogsResponse {
  success: boolean;
  logs: FlowLogEntry[];
  total: number;
}

export interface WebhookStatsResponse {
  success: boolean;
  stats?: {
    totalCalls: number;
    successfulCalls: number;
    failedCalls: number;
    avgResponseTime: number;
  };
  error?: string;
}

// ==================== Connector Endpoints ====================

export interface ConnectorResponse {
  success: boolean;
  connector?: {
    id: string;
    type: string;
    name: string;
    config: Record<string, unknown>;
    status: "connected" | "error" | "pending";
  };
  error?: string;
}

export interface ConnectorListResponse {
  success: boolean;
  connectors: Array<{
    id: string;
    type: string;
    name: string;
    status: "connected" | "error" | "pending";
  }>;
}

// ==================== API Key Endpoints ====================

export interface ApiKey {
  id: string;
  name: string;
  prefix: string;
  lastUsedAt?: string;
  createdAt: string;
  expiresAt?: string;
}

export interface ApiKeyListResponse {
  success: boolean;
  apiKeys: ApiKey[];
}

export interface ApiKeyCreateResponse {
  success: boolean;
  apiKey?: ApiKey;
  /** Full key - only returned on creation */
  key?: string;
  error?: string;
}

export interface ApiKeyDeleteResponse {
  success: boolean;
  error?: string;
}

// ==================== Model Endpoints ====================

export interface AIModel {
  id: string;
  name: string;
  provider: string;
  description?: string;
  contextLength?: number;
  supportsTools?: boolean;
  requiredTier?: "pro" | "enterprise";
  locked?: boolean;
}

export interface ModelListResponse {
  success: boolean;
  models: AIModel[];
}

// ==================== Generic Response Types ====================

export interface SuccessResponse {
  success: true;
}

export interface ErrorResponse {
  success: false;
  error: string;
}

export type ApiResult<T> = (T & { success: true }) | ErrorResponse;

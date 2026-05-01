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
  chartSpec?: Record<string, unknown>;
  resultsViewMode?: "table" | "json" | "chart";
  access?: "private" | "workspace";
  owner_id?: string;
  readOnly?: boolean;
  schedule?: {
    cron: string;
    timezone: string;
  };
  scheduledRun?: {
    nextAt?: string;
    lastAt?: string;
    lastStatus?: "success" | "error";
    lastError?: string;
    lastDurationMs?: number;
    lastRowsAffected?: number;
    lastRowCount?: number;
    runCount: number;
    consecutiveFailures: number;
  };
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

export interface ScheduledQueryRunItem {
  id: string;
  triggeredAt: string;
  startedAt?: string;
  completedAt?: string;
  status: "queued" | "running" | "success" | "error";
  triggerType: "schedule" | "manual";
  triggeredBy?: string;
  durationMs?: number;
  rowsAffected?: number;
  rowCount?: number;
  error?: {
    message: string;
    code?: string;
  };
  inngestRunId?: string;
}

export interface ScheduledQueryRunsResponse {
  success: boolean;
  runs: ScheduledQueryRunItem[];
  /** Latest snapshot from SavedConsole.scheduledRun (for Runs tab counter). */
  scheduledRun?: ConsoleContentResponse["scheduledRun"];
  error?: string;
}

export interface ScheduledQueryScheduleResponse {
  success: boolean;
  schedule?: {
    cron: string;
    timezone: string;
  };
  scheduledRun?: ConsoleContentResponse["scheduledRun"];
  eventId?: string;
  error?: string;
}

export interface ScheduledQueryListItem {
  id: string;
  name: string;
  connectionId?: string;
  databaseId?: string;
  databaseName?: string;
  schedule?: {
    cron: string;
    timezone: string;
  };
  scheduledRun?: ConsoleContentResponse["scheduledRun"];
  access?: "private" | "workspace";
  owner_id?: string;
  updatedAt?: string;
}

export interface ScheduledQueryListResponse {
  success: boolean;
  scheduledQueries: ScheduledQueryListItem[];
}

// ==================== Flow run notifications ====================

export type NotificationResourceTypeApi = "scheduled_query" | "flow";

export type NotificationTriggerApi = "success" | "failure";

export type NotificationChannelTypeApi = "email" | "webhook" | "slack";

export interface NotificationRuleChannelEmailApi {
  type: "email";
  recipients: string[];
}

export interface NotificationRuleChannelWebhookApi {
  type: "webhook";
  urlPreview: string;
  hasSigningSecret: boolean;
}

export interface NotificationRuleChannelSlackApi {
  type: "slack";
  displayLabel: string;
  webhookConfigured: boolean;
}

export type NotificationRuleChannelApi =
  | NotificationRuleChannelEmailApi
  | NotificationRuleChannelWebhookApi
  | NotificationRuleChannelSlackApi;

export interface NotificationRuleApi {
  id: string;
  workspaceId: string;
  resourceType: NotificationResourceTypeApi;
  resourceId: string;
  enabled: boolean;
  triggers: NotificationTriggerApi[];
  channel: NotificationRuleChannelApi;
  createdBy: string;
  createdAt: string;
  updatedAt: string;
}

export interface NotificationRulesListResponse {
  success: boolean;
  rules: NotificationRuleApi[];
}

export interface NotificationDeliveryApi {
  id: string;
  ruleId: string;
  runId: string;
  trigger: NotificationTriggerApi;
  channelType: NotificationChannelTypeApi;
  status: "pending" | "sent" | "failed" | "skipped";
  attempts: number;
  lastError?: string;
  httpStatus?: number;
  sentAt?: string;
  completedAt?: string;
  createdAt: string;
}

export interface NotificationDeliveriesResponse {
  success: boolean;
  deliveries: NotificationDeliveryApi[];
}

export interface NotificationRuleCreateResponse {
  success: boolean;
  rule: NotificationRuleApi;
  signingSecretOnce?: string;
}

export interface NotificationRuleUpdateResponse {
  success: boolean;
  rule: NotificationRuleApi;
  signingSecretOnce?: string;
}

export interface NotificationTestResponse {
  success: boolean;
  message?: string;
}

// ==================== Query Execution Endpoints ====================

export interface QueryExecuteResponse {
  success: boolean;
  rows?: Array<Record<string, unknown>>;
  pageInfo?: {
    pageSize: number;
    hasMore: boolean;
    nextCursor: string | null;
    returnedRows: number;
    capApplied: boolean;
  };
  error?: string;
  executionTime?: number;
  rowCount?: number;
  fields?: Array<
    { name?: string; originalName?: string; type?: string } | string
  >;
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
  tier?: "free" | "pro";
  supportsThinking?: boolean;
  blendedCostPerM?: number;
  contextLength?: number;
  supportsTools?: boolean;
}

export interface GatewayModelInfo {
  id: string;
  name: string;
  description: string;
  provider: string;
  contextWindow: number | null;
  tags: string[];
}

export interface ModelListResponse {
  success: boolean;
  models: AIModel[];
  /**
   * Server-side recommended default for this workspace. The client should
   * reset its persisted `selectedModelId` to this value when the current
   * selection is no longer available (e.g. super-admin hid the model).
   *
   * Mirrors the fallback logic in POST /agent/chat so the selector shows
   * the model the server will actually run.
   */
  recommendedModelId?: string | null;
}

export interface GatewayModelsResponse {
  models: GatewayModelInfo[];
}

export interface DisabledModelsResponse {
  success: boolean;
  disabledModelIds: string[];
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

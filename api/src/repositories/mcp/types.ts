/**
 * Repository types for Phase 3 (Part 1) `mcp` domain:
 *   - `mcp_servers`
 *   - `mcp_connection_configs`
 *   - `mcp_oauth_flows`
 *   - `mcp_tool_grants`
 *
 * All external/wire IDs (`id`, `workspaceId`, `serverId`) are canonical 24-hex
 * Mongo ObjectIds during dual-run (`toWireId`), while Postgres stores bijective
 * RFC 9562 UUIDv8 values.
 *
 * Workspace-shared credentials use `userId: null` / `configUserId: null`
 * (mapped to Mongo `""` sentinel and Postgres `NULL` with `UNIQUE NULLS NOT DISTINCT`).
 */
import type {
  IMcpCachedTool,
  McpAuthPerformer,
  McpAuthType,
  McpGrantDecision,
  McpServerStatus,
  McpToolRestriction,
  McpTransportType,
  McpWriteScope,
} from "../../database/models/mcp";

export {
  MCP_SERVER_WIDE_GRANT_TOOL,
  type IMcpCachedTool,
  type McpAuthPerformer,
  type McpAuthType,
  type McpGrantDecision,
  type McpServerStatus,
  type McpToolRestriction,
  type McpTransportType,
  type McpWriteScope,
} from "../../database/models/mcp";

/** 10-minute TTL window for pending MCP OAuth PKCE flows. */
export const MCP_OAUTH_FLOW_TTL_MS = 10 * 60 * 1000;

export class McpDuplicateServerNameError extends Error {
  readonly code = "MCP_DUPLICATE_SERVER_NAME" as const;
  constructor(name?: string) {
    super(
      name
        ? `A server named "${name}" already exists in this workspace`
        : "A server with this name already exists",
    );
    this.name = "McpDuplicateServerNameError";
  }
}

export function isDuplicateServerNameError(error: unknown): boolean {
  if (error instanceof McpDuplicateServerNameError) return true;
  if (!error || typeof error !== "object") return false;
  const err = error as { code?: unknown; cause?: { code?: unknown } };
  return (
    err.code === 11000 || err.code === "23505" || err.cause?.code === "23505"
  );
}

export interface McpServerRecord {
  id: string;
  workspaceId: string;
  name: string;
  description: string | null;
  connectorType: string;
  transport: {
    type: McpTransportType;
    url: string;
  };
  authType: McpAuthType;
  authPerformer: McpAuthPerformer;
  writeScope: McpWriteScope;
  toolPolicy: {
    defaultRestriction: McpToolRestriction;
    restrictions: Record<string, McpToolRestriction>;
  };
  cachedTools: IMcpCachedTool[];
  /** Opaque AES ciphertext of JSON OAuth client info (never decrypted by repo). */
  oauthClientInformationEncrypted: string | null;
  status: McpServerStatus;
  lastError: string | null;
  lastConnectedAt: Date | null;
  /** Nullable when creator was deleted or legacy `"system"`. */
  createdBy: string | null;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

export interface McpConnectionConfigRecord {
  id: string;
  workspaceId: string;
  serverId: string;
  /** `null` for workspace-shared credentials (Mongo `""`), else user ID. */
  userId: string | null;
  /** Opaque encrypted headers map `{ headerName: "iv:ciphertext" }`. */
  headersEncrypted: Record<string, string>;
  /** Opaque AES ciphertext of JSON `OAuthTokens`. */
  oauthTokensEncrypted: string | null;
  /** Absolute epoch-ms expiry of the access token, or null. */
  oauthExpiresAt: number | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface McpOAuthFlowRecord {
  id: string;
  state: string;
  workspaceId: string;
  serverId: string;
  /** `null` for workspace-shared credentials (Mongo `""`), else user ID. */
  configUserId: string | null;
  startedByUserId: string;
  /** Opaque AES ciphertext of PKCE code verifier. */
  codeVerifierEncrypted: string | null;
  createdAt: Date;
}

export interface McpToolGrantRecord {
  id: string;
  workspaceId: string;
  serverId: string;
  userId: string;
  toolName: string;
  decision: McpGrantDecision;
  lastUsedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CreateMcpServerInput {
  id?: string;
  workspaceId: string;
  name: string;
  description?: string | null;
  connectorType: string;
  transport: { type: McpTransportType; url: string };
  authType: McpAuthType;
  authPerformer: McpAuthPerformer;
  writeScope: McpWriteScope;
  toolPolicy?: {
    defaultRestriction: McpToolRestriction;
    restrictions: Record<string, McpToolRestriction>;
  };
  cachedTools?: IMcpCachedTool[];
  oauthClientInformationEncrypted?: string | null;
  status?: McpServerStatus;
  lastError?: string | null;
  lastConnectedAt?: Date | null;
  createdBy: string | null;
  isActive?: boolean;
  createdAt?: Date;
  updatedAt?: Date;
}

export interface UpdateMcpServerPatch {
  name?: string;
  description?: string | null;
  transport?: { type: McpTransportType; url: string };
  writeScope?: McpWriteScope;
  isActive?: boolean;
  toolPolicy?: {
    defaultRestriction?: McpToolRestriction;
    restrictions?: Record<string, McpToolRestriction>;
  };
  cachedTools?: IMcpCachedTool[];
  oauthClientInformationEncrypted?: string | null;
  status?: McpServerStatus;
  lastError?: string | null;
  lastConnectedAt?: Date | null;
  updatedAt?: Date;
}

export interface UpsertMcpCredentialsInput {
  id?: string;
  workspaceId: string;
  serverId: string;
  /** `null` or `""` for workspace-shared credentials. */
  userId: string | null;
  headersEncrypted: Record<string, string>;
  now?: Date;
}

export interface UpsertMcpOAuthTokensInput {
  id?: string;
  workspaceId: string;
  serverId: string;
  /** `null` or `""` for workspace-shared credentials. */
  userId: string | null;
  oauthTokensEncrypted: string;
  oauthExpiresAt: number | null;
  now?: Date;
}

export interface UpsertMcpOAuthFlowInput {
  id?: string;
  state: string;
  workspaceId: string;
  serverId: string;
  /** `null` or `""` for workspace-shared credentials. */
  configUserId: string | null;
  startedByUserId: string;
  codeVerifierEncrypted: string | null;
  createdAt?: Date;
}

export interface UpsertMcpToolGrantInput {
  id?: string;
  workspaceId: string;
  serverId: string;
  userId: string;
  toolName: string;
  decision: McpGrantDecision;
  now?: Date;
}

export interface McpRepository {
  // ── Servers ──────────────────────────────────────────────────────────────
  listServersByWorkspace(workspaceId: string): Promise<McpServerRecord[]>;
  listActiveConnectedServers(workspaceId: string): Promise<McpServerRecord[]>;
  findServerById(
    serverId: string,
    workspaceId?: string,
  ): Promise<McpServerRecord | null>;
  createServer(input: CreateMcpServerInput): Promise<McpServerRecord>;
  updateServer(
    workspaceId: string,
    serverId: string,
    patch: UpdateMcpServerPatch,
  ): Promise<McpServerRecord | null>;
  deleteServerCascade(workspaceId: string, serverId: string): Promise<boolean>;

  // ── Connection configs (credentials + OAuth tokens) ──────────────────────
  listConnectionConfigsByServerIds(
    workspaceId: string,
    serverIds: readonly string[],
  ): Promise<McpConnectionConfigRecord[]>;
  /**
   * List workspace-shared (`userId === null`) configs AND the given user's
   * per-user configs (`userId !== null`) across `serverIds`, resolving legacy
   * session user IDs against Postgres `users(id, legacy_id)` during mixed-mode
   * rollout.
   */
  listConnectionConfigsForUser(
    workspaceId: string,
    serverIds: readonly string[],
    userId: string | null,
  ): Promise<McpConnectionConfigRecord[]>;
  findConnectionConfig(
    workspaceId: string,
    serverId: string,
    userId: string | null,
  ): Promise<McpConnectionConfigRecord | null>;
  upsertConnectionCredentials(
    input: UpsertMcpCredentialsInput,
  ): Promise<McpConnectionConfigRecord>;
  upsertConnectionOAuthTokens(
    input: UpsertMcpOAuthTokensInput,
  ): Promise<McpConnectionConfigRecord>;
  clearServerOAuthTokens(
    workspaceId: string,
    serverId: string,
    now?: Date,
  ): Promise<void>;

  // ── OAuth PKCE flows (10m ephemeral TTL) ─────────────────────────────────
  upsertOAuthFlow(input: UpsertMcpOAuthFlowInput): Promise<McpOAuthFlowRecord>;
  findOAuthFlowByState(
    state: string,
    now?: Date,
  ): Promise<McpOAuthFlowRecord | null>;
  findOAuthFlowById(
    flowId: string,
    workspaceId?: string,
    now?: Date,
  ): Promise<McpOAuthFlowRecord | null>;
  deleteOAuthFlowById(flowId: string, workspaceId?: string): Promise<boolean>;

  /**
   * Compare two user identifiers across legacy Mongo IDs and PG UUIDv7s so
   * OAuth callback ownership checks work seamlessly during mixed-mode rollout.
   */
  isSameUser(
    userIdA: string | null | undefined,
    userIdB: string | null | undefined,
  ): Promise<boolean>;

  // ── Per-user tool grants ─────────────────────────────────────────────────
  listToolGrantsForUser(
    workspaceId: string,
    serverId: string,
    userId: string,
  ): Promise<McpToolGrantRecord[]>;
  findToolGrantsForResolution(params: {
    serverId: string;
    userId: string;
    toolName: string;
    workspaceId?: string;
  }): Promise<McpToolGrantRecord[]>;
  upsertToolGrant(input: UpsertMcpToolGrantInput): Promise<McpToolGrantRecord>;
  touchToolGrantLastUsed(params: {
    workspaceId: string;
    serverId: string;
    userId: string;
    toolName: string;
    at?: Date;
  }): Promise<void>;
  deleteToolGrantById(
    workspaceId: string,
    serverId: string,
    grantId: string,
    userId: string,
  ): Promise<boolean>;
}

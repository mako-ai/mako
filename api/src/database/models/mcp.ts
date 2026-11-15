import mongoose, { Schema, Document, Types } from "mongoose";

/**
 * MCP (Model Context Protocol) integration.
 *
 * Three collections, modeled after Onyx's split between server definitions
 * and credentials:
 *  - `mcp_servers`            — workspace-level server definition (URL,
 *                               transport, tool policy, cached tool list).
 *  - `mcp_connection_configs` — encrypted credentials; one per workspace
 *                               (shared) or one per user, depending on the
 *                               server's `authPerformer`.
 *  - `mcp_tool_grants`        — per-user "always allow" / "always deny"
 *                               decisions that back the chat approval flow.
 */

export type McpTransportType = "http";
export type McpAuthType = "none" | "api_key" | "oauth";
/**
 * Who supplies credentials. Following the Claude-connectors model, every
 * user authenticates individually ("user") — enabling a connector for the
 * workspace never grants shared data access. "workspace" is retained for
 * backward compatibility with early servers only.
 */
export type McpAuthPerformer = "workspace" | "user";

/**
 * Admin-set permission ceiling for one tool (Claude-connectors model):
 *  - "always": users can choose Always allow, Ask, or Block
 *  - "ask":    users can choose Ask or Block (never Always allow)
 *  - "block":  the tool is never exposed to the agent
 * Restrictions set a ceiling — users can always choose a stricter setting.
 */
export type McpToolRestriction = "always" | "ask" | "block";
export type McpWriteScope = "read" | "write_safe" | "write_destructive";
export type McpServerStatus =
  "created" | "awaiting_auth" | "connected" | "error";

export interface IMcpCachedTool {
  name: string;
  description?: string;
  /** JSON Schema for the tool's input, captured at discovery time. */
  inputSchema?: Record<string, unknown>;
  /** MCP tool annotations (readOnlyHint, destructiveHint, ...) if provided. */
  annotations?: {
    readOnlyHint?: boolean;
    destructiveHint?: boolean;
    idempotentHint?: boolean;
    [key: string]: unknown;
  };
}

export interface IMcpServer extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  name: string;
  description?: string;
  /** Preset key ("close", "custom", ...) — drives the config form + defaults. */
  connectorType: string;
  transport: {
    type: McpTransportType;
    url: string;
  };
  authType: McpAuthType;
  authPerformer: McpAuthPerformer;
  /**
   * Write capability requested from the server. For servers with a scope
   * header preset (e.g. Close's `Close-Scope`), this is sent on connect and
   * enforced server-side by the provider. Also used as the fallback risk
   * tier for tools without MCP annotations.
   */
  writeScope: McpWriteScope;
  toolPolicy: {
    /**
     * Ceiling applied to tools without a specific restriction below —
     * including tools the server adds later.
     */
    defaultRestriction: McpToolRestriction;
    /** Per-tool ceilings, keyed by the raw MCP tool name. */
    restrictions: Record<string, McpToolRestriction>;
  };
  /**
   * OAuth client registration (Dynamic Client Registration) for this server.
   * Shared across all users connecting to the server; per-user tokens live on
   * their `mcp_connection_configs` document. `clientInformation` is the
   * encrypted JSON of the DCR response (client_id, client_secret, ...).
   */
  oauth?: {
    clientInformation?: string;
  };
  /** Discovered tools from the last successful connect/test. */
  cachedTools: IMcpCachedTool[];
  status: McpServerStatus;
  lastError?: string;
  lastConnectedAt?: Date;
  createdBy: string;
  isActive: boolean;
  createdAt: Date;
  updatedAt: Date;
}

const McpServerSchema = new Schema<IMcpServer>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    name: { type: String, required: true, trim: true, maxlength: 100 },
    description: { type: String, trim: true, maxlength: 500 },
    connectorType: { type: String, required: true, default: "custom" },
    transport: {
      type: new Schema(
        {
          type: { type: String, enum: ["http"], required: true },
          url: { type: String, required: true },
        },
        { _id: false },
      ),
      required: true,
    },
    authType: {
      type: String,
      enum: ["none", "api_key", "oauth"],
      required: true,
      default: "api_key",
    },
    authPerformer: {
      type: String,
      enum: ["workspace", "user"],
      required: true,
      default: "workspace",
    },
    writeScope: {
      type: String,
      enum: ["read", "write_safe", "write_destructive"],
      required: true,
      default: "read",
    },
    toolPolicy: {
      type: new Schema(
        {
          defaultRestriction: {
            type: String,
            enum: ["always", "ask", "block"],
            required: true,
            default: "always",
          },
          restrictions: { type: Schema.Types.Mixed, default: {} },
        },
        { _id: false },
      ),
      required: true,
      default: () => ({
        defaultRestriction: "always",
        restrictions: {},
      }),
    },
    cachedTools: {
      type: [
        new Schema<IMcpCachedTool>(
          {
            name: { type: String, required: true },
            description: { type: String },
            inputSchema: { type: Schema.Types.Mixed },
            annotations: { type: Schema.Types.Mixed },
          },
          { _id: false },
        ),
      ],
      default: [],
    },
    oauth: {
      type: new Schema(
        {
          clientInformation: { type: String },
        },
        { _id: false },
      ),
      required: false,
    },
    status: {
      type: String,
      enum: ["created", "awaiting_auth", "connected", "error"],
      required: true,
      default: "created",
    },
    lastError: { type: String },
    lastConnectedAt: { type: Date },
    createdBy: { type: String, required: true },
    isActive: { type: Boolean, default: true },
  },
  { collection: "mcp_servers", timestamps: true },
);

McpServerSchema.index({ workspaceId: 1, name: 1 }, { unique: true });
McpServerSchema.index({ workspaceId: 1, isActive: 1 });

export const McpServer = mongoose.model<IMcpServer>(
  "McpServer",
  McpServerSchema,
);

export interface IMcpConnectionConfig extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  serverId: Types.ObjectId;
  /** Empty string for the shared workspace credential; else the user id. */
  userId: string;
  /** Encrypted header values (crypto.service `iv:ciphertext` format). */
  headers: Record<string, string>;
  /** OAuth tokens for this connection (encrypted JSON of OAuthTokens). */
  oauthTokens?: string;
  /** Absolute epoch-ms expiry of the current access token, if known. */
  oauthExpiresAt?: number;
  createdAt: Date;
  updatedAt: Date;
}

const McpConnectionConfigSchema = new Schema<IMcpConnectionConfig>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    serverId: {
      type: Schema.Types.ObjectId,
      ref: "McpServer",
      required: true,
    },
    userId: { type: String, required: false, default: "" },
    headers: { type: Schema.Types.Mixed, default: {} },
    oauthTokens: { type: String },
    oauthExpiresAt: { type: Number },
  },
  { collection: "mcp_connection_configs", timestamps: true },
);

McpConnectionConfigSchema.index({ serverId: 1, userId: 1 }, { unique: true });
McpConnectionConfigSchema.index({ workspaceId: 1 });

export const McpConnectionConfig = mongoose.model<IMcpConnectionConfig>(
  "McpConnectionConfig",
  McpConnectionConfigSchema,
);

/**
 * Pending MCP OAuth authorization flow: one document per in-flight browser
 * redirect, keyed by the unguessable `state` parameter. Holds the PKCE code
 * verifier until the callback exchanges the authorization code. TTL-reaped
 * after 10 minutes.
 */
export interface IMcpOAuthFlow extends Document {
  _id: Types.ObjectId;
  state: string;
  workspaceId: Types.ObjectId;
  serverId: Types.ObjectId;
  /** User who started the flow ("" for the shared workspace credential). */
  configUserId: string;
  /** Session user who must complete the callback. */
  startedByUserId: string;
  /** Encrypted PKCE code verifier. */
  codeVerifier?: string;
  createdAt: Date;
}

const McpOAuthFlowSchema = new Schema<IMcpOAuthFlow>(
  {
    state: { type: String, required: true },
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    serverId: {
      type: Schema.Types.ObjectId,
      ref: "McpServer",
      required: true,
    },
    configUserId: { type: String, required: true, default: "" },
    startedByUserId: { type: String, required: true },
    codeVerifier: { type: String },
  },
  { collection: "mcp_oauth_flows", timestamps: { createdAt: true } },
);

McpOAuthFlowSchema.index({ state: 1 }, { unique: true });
McpOAuthFlowSchema.index({ createdAt: 1 }, { expireAfterSeconds: 600 });

export const McpOAuthFlow = mongoose.model<IMcpOAuthFlow>(
  "McpOAuthFlow",
  McpOAuthFlowSchema,
);

export type McpGrantDecision = "always_allow" | "always_deny";

/**
 * Sentinel toolName for a per-user, server-wide grant. Applies to every tool
 * on the server that the admin ceiling still permits (ask/block ceilings win).
 */
export const MCP_SERVER_WIDE_GRANT_TOOL = "*";

export interface IMcpToolGrant extends Document {
  _id: Types.ObjectId;
  workspaceId: Types.ObjectId;
  serverId: Types.ObjectId;
  /** Grants are always per-user, even on shared workspace credentials. */
  userId: string;
  /**
   * Raw MCP tool name, or {@link MCP_SERVER_WIDE_GRANT_TOOL} (`"*"`) for a
   * server-wide Always allow / Block decision.
   */
  toolName: string;
  decision: McpGrantDecision;
  lastUsedAt?: Date;
  createdAt: Date;
  updatedAt: Date;
}

const McpToolGrantSchema = new Schema<IMcpToolGrant>(
  {
    workspaceId: {
      type: Schema.Types.ObjectId,
      ref: "Workspace",
      required: true,
    },
    serverId: {
      type: Schema.Types.ObjectId,
      ref: "McpServer",
      required: true,
    },
    userId: { type: String, required: true },
    toolName: { type: String, required: true },
    decision: {
      type: String,
      enum: ["always_allow", "always_deny"],
      required: true,
    },
    lastUsedAt: { type: Date },
  },
  { collection: "mcp_tool_grants", timestamps: true },
);

McpToolGrantSchema.index(
  { serverId: 1, userId: 1, toolName: 1 },
  { unique: true },
);
McpToolGrantSchema.index({ workspaceId: 1, userId: 1 });

export const McpToolGrant = mongoose.model<IMcpToolGrant>(
  "McpToolGrant",
  McpToolGrantSchema,
);

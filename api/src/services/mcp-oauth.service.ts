/**
 * MCP OAuth 2.0 client flows (Close CRM / Slack "log in with your personal
 * account").
 *
 * Persistence is routed through `mcpRepo` (dual-run MongoDB / Neon Postgres):
 *  - OAuth client registration is per server (`oauthClientInformationEncrypted`).
 *  - Tokens are per connection config (`oauthTokensEncrypted`, `oauthExpiresAt`).
 *  - In-flight browser redirects live in `mcp_oauth_flows` (10m ephemeral TTL).
 */

import crypto from "node:crypto";
import {
  auth,
  UnauthorizedError,
  type OAuthClientProvider,
} from "@modelcontextprotocol/sdk/client/auth.js";
import type {
  OAuthClientInformationMixed,
  OAuthClientMetadata,
  OAuthTokens,
} from "@modelcontextprotocol/sdk/shared/auth.js";
import type { IMcpServer } from "../database/workspace-schema";
import {
  mcpRepo,
  normalizeConfigUserId,
  type McpServerRecord,
  type McpWriteScope,
} from "../repositories/mcp";
import {
  getMcpPreset,
  mcpPresetEnvOAuthClient,
  mcpPresetOAuthScope,
} from "../mcp/presets";
import { decryptString, encryptString } from "./crypto.service";
import { loggers } from "../logging";

const logger = loggers.api("mcp-oauth");

/** Accepts either canonical `McpServerRecord` or legacy Mongoose `IMcpServer` (tests). */
export type McpOAuthServerInput = McpServerRecord | IMcpServer;

interface NormalizedServerRef {
  id: string;
  workspaceId: string;
  name: string;
  connectorType: string;
  transportUrl: string;
  writeScope: McpWriteScope;
  oauthClientInformationEncrypted: string | null;
}

function normalizeServerRef(server: McpOAuthServerInput): NormalizedServerRef {
  const isRecord = "id" in server && typeof server.id === "string";
  const id = isRecord ? server.id : (server as IMcpServer)._id.toString();
  const workspaceId =
    typeof server.workspaceId === "string"
      ? server.workspaceId
      : server.workspaceId.toString();
  const oauthClientInformationEncrypted =
    "oauthClientInformationEncrypted" in server
      ? (server.oauthClientInformationEncrypted ?? null)
      : ((server as IMcpServer).oauth?.clientInformation ?? null);

  return {
    id,
    workspaceId,
    name: server.name,
    connectorType: server.connectorType,
    transportUrl: server.transport.url,
    writeScope: server.writeScope,
    oauthClientInformationEncrypted,
  };
}

/** Where the OAuth provider redirects back to after user consent. */
export function mcpOAuthCallbackUrl(): string {
  const base =
    process.env.PUBLIC_URL || process.env.CLIENT_URL || "http://localhost:5173";
  return `${base.replace(/\/$/, "")}/api/mcp/oauth/callback`;
}

class RedirectRequested extends Error {
  constructor(public readonly authorizationUrl: URL) {
    super("OAuth redirect requested");
  }
}

/**
 * Repository-backed OAuthClientProvider. One instance per (server, connection,
 * flow) invocation; all state round-trips through `mcpRepo` so any API instance
 * can complete a flow another instance started.
 */
class McpOAuthClientProvider implements OAuthClientProvider {
  private flowState: string | undefined;
  private readonly serverRef: NormalizedServerRef;
  private readonly normalizedConfigUserId: string | null;

  constructor(
    server: McpOAuthServerInput,
    configUserId: string | null,
    /** Set while completing a callback (loads the persisted verifier). */
    private readonly pendingFlowId?: string,
  ) {
    this.serverRef = normalizeServerRef(server);
    this.normalizedConfigUserId = normalizeConfigUserId(configUserId);
  }

  get redirectUrl(): string {
    return mcpOAuthCallbackUrl();
  }

  get clientMetadata(): OAuthClientMetadata {
    return {
      client_name: "Mako",
      redirect_uris: [this.redirectUrl],
      grant_types: ["authorization_code", "refresh_token"],
      response_types: ["code"],
      token_endpoint_auth_method: "client_secret_post",
    };
  }

  async state(): Promise<string> {
    if (!this.flowState) {
      this.flowState = crypto.randomBytes(24).toString("base64url");
    }
    return this.flowState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const doc = await mcpRepo.findServerById(
      this.serverRef.id,
      this.serverRef.workspaceId,
    );
    const encrypted = doc?.oauthClientInformationEncrypted;
    if (encrypted) {
      try {
        return JSON.parse(
          decryptString(encrypted),
        ) as OAuthClientInformationMixed;
      } catch {
        // Corrupt/unreadable — fall through to the env client, if any.
      }
    }
    return mcpPresetEnvOAuthClient(getMcpPreset(this.serverRef.connectorType));
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    await mcpRepo.updateServer(this.serverRef.workspaceId, this.serverRef.id, {
      oauthClientInformationEncrypted: encryptString(
        JSON.stringify(clientInformation),
      ),
    });
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const config = await mcpRepo.findConnectionConfig(
      this.serverRef.workspaceId,
      this.serverRef.id,
      this.normalizedConfigUserId,
    );
    if (!config?.oauthTokensEncrypted) return undefined;
    try {
      return JSON.parse(
        decryptString(config.oauthTokensEncrypted),
      ) as OAuthTokens;
    } catch {
      return undefined;
    }
  }

  async saveTokens(tokens: OAuthTokens): Promise<void> {
    // Preserve the refresh token across refreshes that omit it.
    const existing = await this.tokens();
    const merged: OAuthTokens = {
      ...tokens,
      refresh_token: tokens.refresh_token ?? existing?.refresh_token,
    };
    await mcpRepo.upsertConnectionOAuthTokens({
      workspaceId: this.serverRef.workspaceId,
      serverId: this.serverRef.id,
      userId: this.normalizedConfigUserId,
      oauthTokensEncrypted: encryptString(JSON.stringify(merged)),
      oauthExpiresAt: merged.expires_in
        ? Date.now() + merged.expires_in * 1000
        : null,
    });
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    throw new RedirectRequested(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await mcpRepo.upsertOAuthFlow({
      state: await this.state(),
      workspaceId: this.serverRef.workspaceId,
      serverId: this.serverRef.id,
      configUserId: this.normalizedConfigUserId,
      startedByUserId: this.startedByUserId ?? "",
      codeVerifierEncrypted: encryptString(codeVerifier),
    });
  }

  /** Set by startMcpOAuthFlow so saveCodeVerifier can persist the owner. */
  startedByUserId?: string;

  async codeVerifier(): Promise<string> {
    if (!this.pendingFlowId) {
      throw new Error("No pending OAuth flow to load the code verifier from");
    }
    const flow = await mcpRepo.findOAuthFlowById(
      this.pendingFlowId,
      this.serverRef.workspaceId,
    );
    if (!flow?.codeVerifierEncrypted) {
      throw new Error("OAuth flow expired — start the connection again");
    }
    return decryptString(flow.codeVerifierEncrypted);
  }
}

function oauthScopeForServer(server: NormalizedServerRef): string | undefined {
  return mcpPresetOAuthScope(
    getMcpPreset(server.connectorType),
    server.writeScope,
  );
}

/**
 * Save a pre-registered (manual) OAuth client for a server — used by
 * providers that don't support Dynamic Client Registration (Slack).
 */
export async function saveMcpOAuthClient(params: {
  server: McpOAuthServerInput;
  clientId: string;
  clientSecret?: string;
}): Promise<void> {
  const ref = normalizeServerRef(params.server);
  await mcpRepo.updateServer(ref.workspaceId, ref.id, {
    oauthClientInformationEncrypted: encryptString(
      JSON.stringify({
        client_id: params.clientId,
        ...(params.clientSecret ? { client_secret: params.clientSecret } : {}),
      }),
    ),
  });
  await mcpRepo.clearServerOAuthTokens(ref.workspaceId, ref.id);
  logger.info("MCP OAuth client saved", { serverId: ref.id });
}

export type McpOAuthClientSource = "workspace" | "environment";

export function mcpOAuthClientSource(
  server:
    | Pick<McpServerRecord, "connectorType" | "oauthClientInformationEncrypted">
    | Pick<IMcpServer, "connectorType" | "oauth">,
): McpOAuthClientSource | null {
  const hasWorkspaceClient =
    "oauthClientInformationEncrypted" in server
      ? Boolean(server.oauthClientInformationEncrypted)
      : Boolean(server.oauth?.clientInformation);
  if (hasWorkspaceClient) return "workspace";
  if (mcpPresetEnvOAuthClient(getMcpPreset(server.connectorType))) {
    return "environment";
  }
  return null;
}

export async function hasMcpOAuthClient(
  server: McpOAuthServerInput,
): Promise<boolean> {
  const ref = normalizeServerRef(server);
  const doc = await mcpRepo.findServerById(ref.id, ref.workspaceId);
  if (doc) return mcpOAuthClientSource(doc) !== null;
  return (
    mcpOAuthClientSource({
      connectorType: ref.connectorType,
      oauthClientInformationEncrypted: ref.oauthClientInformationEncrypted,
    }) !== null
  );
}

export async function startMcpOAuthFlow(params: {
  server: McpOAuthServerInput;
  configUserId: string;
  startedByUserId: string;
}): Promise<{ authorizationUrl: string }> {
  const { server, configUserId, startedByUserId } = params;
  const ref = normalizeServerRef(server);
  const preset = getMcpPreset(ref.connectorType);

  if (
    preset.oauth?.clientMode === "manual" &&
    !(await hasMcpOAuthClient(server))
  ) {
    throw new Error(
      `${preset.label} requires a pre-registered OAuth app — a workspace admin must save its Client ID and Client Secret first`,
    );
  }

  const provider = new McpOAuthClientProvider(server, configUserId);
  provider.startedByUserId = startedByUserId;

  try {
    const result = await auth(provider, {
      serverUrl: ref.transportUrl,
      scope: oauthScopeForServer(ref),
    });
    if (result === "AUTHORIZED") {
      return { authorizationUrl: "" };
    }
    throw new Error(`Unexpected auth result: ${result}`);
  } catch (error) {
    if (error instanceof RedirectRequested) {
      logger.info("MCP OAuth flow started", {
        serverId: ref.id,
        configUserId,
      });
      return { authorizationUrl: error.authorizationUrl.toString() };
    }
    throw error;
  }
}

export async function findMcpOAuthFlowServerId(
  state: string,
): Promise<string | null> {
  const flow = await mcpRepo.findOAuthFlowByState(state);
  return flow?.serverId ?? null;
}

export async function completeMcpOAuthFlow(params: {
  state: string;
  code: string;
  sessionUserId: string;
}): Promise<{ workspaceId: string; serverId: string }> {
  const { state, code, sessionUserId } = params;
  const flow = await mcpRepo.findOAuthFlowByState(state);
  if (!flow) {
    throw new Error("OAuth flow not found or expired — try connecting again");
  }
  if (flow.startedByUserId !== sessionUserId) {
    throw new Error("This OAuth flow was started by a different user");
  }
  const server = await mcpRepo.findServerById(flow.serverId, flow.workspaceId);
  if (!server) {
    throw new Error("MCP server no longer exists");
  }

  const ref = normalizeServerRef(server);
  const provider = new McpOAuthClientProvider(
    server,
    flow.configUserId,
    flow.id,
  );
  const result = await auth(provider, {
    serverUrl: ref.transportUrl,
    authorizationCode: code,
    scope: oauthScopeForServer(ref),
  });
  if (result !== "AUTHORIZED") {
    throw new UnauthorizedError("Token exchange did not complete");
  }
  await mcpRepo.deleteOAuthFlowById(flow.id, flow.workspaceId);

  if (server.status === "created") {
    await mcpRepo.updateServer(server.workspaceId, server.id, {
      status: "awaiting_auth",
    });
  }
  logger.info("MCP OAuth flow completed", {
    serverId: server.id,
    configUserId: flow.configUserId ?? "",
  });
  return {
    workspaceId: server.workspaceId,
    serverId: server.id,
  };
}

export async function getMcpOAuthAuthorization(
  server: McpOAuthServerInput,
  configUserId: string,
): Promise<{ Authorization: string }> {
  const ref = normalizeServerRef(server);
  const normalizedConfigUserId = normalizeConfigUserId(configUserId);
  const provider = new McpOAuthClientProvider(server, normalizedConfigUserId);

  const tokens = await provider.tokens();
  if (!tokens) {
    throw new UnauthorizedError(
      `No ${ref.name} account connected — connect it in Settings → MCP Servers`,
    );
  }

  const config = await mcpRepo.findConnectionConfig(
    ref.workspaceId,
    ref.id,
    normalizedConfigUserId,
  );
  const expiresSoon =
    typeof config?.oauthExpiresAt === "number" &&
    config.oauthExpiresAt < Date.now() + 30_000;

  if (expiresSoon && tokens.refresh_token) {
    try {
      const result = await auth(provider, {
        serverUrl: ref.transportUrl,
        scope: oauthScopeForServer(ref),
      });
      if (result !== "AUTHORIZED") {
        throw new UnauthorizedError("Token refresh requires re-consent");
      }
      const refreshed = await provider.tokens();
      if (refreshed) {
        return { Authorization: `Bearer ${refreshed.access_token}` };
      }
    } catch (error) {
      if (error instanceof RedirectRequested) {
        throw new UnauthorizedError(
          `Your ${ref.name} connection expired — reconnect it in Settings → MCP Servers`,
        );
      }
      throw error;
    }
  }

  return { Authorization: `Bearer ${tokens.access_token}` };
}

export { UnauthorizedError as McpUnauthorizedError };

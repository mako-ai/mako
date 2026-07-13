/**
 * MCP OAuth 2.0 client flows (Close CRM / Slack "log in with your personal
 * account").
 *
 * Implements the MCP authorization spec via the official SDK's `auth()`
 * machinery: protected-resource metadata discovery, Dynamic Client
 * Registration (DCR), authorization-code + PKCE, token exchange, and refresh.
 *
 * Client registration comes in two flavors (see `McpPresetOAuthConfig`):
 *  - DCR (Close): Mako registers itself automatically on first connect.
 *  - Manual (Slack): the provider only accepts pre-registered confidential
 *    apps, so an admin saves the app's client ID + secret first
 *    (`saveMcpOAuthClient`). Both are stored on the same encrypted
 *    `mcp_servers.oauth.clientInformation` field, so the SDK's `auth()` uses
 *    them identically and skips DCR whenever client info already exists.
 *
 * Persistence model:
 *  - OAuth client registration is per *server* (`mcp_servers.oauth`,
 *    encrypted) — one OAuth client shared by all connecting users.
 *  - Tokens are per *connection config* (workspace-shared or per-user),
 *    encrypted on `mcp_connection_configs.oauthTokens`.
 *  - In-flight browser redirects live in `mcp_oauth_flows`, keyed by the
 *    `state` parameter, holding the encrypted PKCE verifier (TTL 10 min).
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
import { Types } from "mongoose";
import {
  type IMcpServer,
  McpConnectionConfig,
  McpOAuthFlow,
  McpServer,
} from "../database/workspace-schema";
import { getMcpPreset, mcpPresetOAuthScope } from "../mcp/presets";
import { decryptString, encryptString } from "./crypto.service";
import { loggers } from "../logging";

const logger = loggers.api("mcp-oauth");

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
 * Mongo-backed OAuthClientProvider. One instance per (server, connection,
 * flow) invocation; all state round-trips through the DB so any API instance
 * can complete a flow another instance started.
 */
class MongoOAuthClientProvider implements OAuthClientProvider {
  private flowState: string | undefined;

  constructor(
    private readonly server: IMcpServer,
    private readonly configUserId: string,
    /** Set while completing a callback (loads the persisted verifier). */
    private readonly pendingFlowId?: Types.ObjectId,
  ) {}

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

  /** The state minted for (or restored from) the pending flow document. */
  async state(): Promise<string> {
    if (!this.flowState) {
      this.flowState = crypto.randomBytes(24).toString("base64url");
    }
    return this.flowState;
  }

  async clientInformation(): Promise<OAuthClientInformationMixed | undefined> {
    const doc = await McpServer.findById(this.server._id)
      .select("oauth")
      .lean();
    const encrypted = doc?.oauth?.clientInformation;
    if (!encrypted) return undefined;
    try {
      return JSON.parse(
        decryptString(encrypted),
      ) as OAuthClientInformationMixed;
    } catch {
      return undefined;
    }
  }

  async saveClientInformation(
    clientInformation: OAuthClientInformationMixed,
  ): Promise<void> {
    await McpServer.updateOne(
      { _id: this.server._id },
      {
        $set: {
          "oauth.clientInformation": encryptString(
            JSON.stringify(clientInformation),
          ),
        },
      },
    );
  }

  async tokens(): Promise<OAuthTokens | undefined> {
    const config = await McpConnectionConfig.findOne({
      serverId: this.server._id,
      userId: this.configUserId,
    }).lean();
    if (!config?.oauthTokens) return undefined;
    try {
      return JSON.parse(decryptString(config.oauthTokens)) as OAuthTokens;
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
    await McpConnectionConfig.updateOne(
      { serverId: this.server._id, userId: this.configUserId },
      {
        $set: {
          workspaceId: this.server.workspaceId,
          oauthTokens: encryptString(JSON.stringify(merged)),
          oauthExpiresAt: merged.expires_in
            ? Date.now() + merged.expires_in * 1000
            : undefined,
        },
        $setOnInsert: { headers: {} },
      },
      { upsert: true },
    );
  }

  async redirectToAuthorization(authorizationUrl: URL): Promise<void> {
    // We can't redirect a browser from here — surface the URL to the route
    // handler, which returns it to the frontend for `window.location`.
    throw new RedirectRequested(authorizationUrl);
  }

  async saveCodeVerifier(codeVerifier: string): Promise<void> {
    await McpOAuthFlow.updateOne(
      { state: await this.state() },
      {
        $set: {
          workspaceId: this.server.workspaceId,
          serverId: this.server._id,
          configUserId: this.configUserId,
          codeVerifier: encryptString(codeVerifier),
        },
        $setOnInsert: { startedByUserId: this.startedByUserId ?? "" },
      },
      { upsert: true },
    );
  }

  /** Set by startMcpOAuthFlow so saveCodeVerifier can persist the owner. */
  startedByUserId?: string;

  async codeVerifier(): Promise<string> {
    if (!this.pendingFlowId) {
      throw new Error("No pending OAuth flow to load the code verifier from");
    }
    const flow = await McpOAuthFlow.findById(this.pendingFlowId).lean();
    if (!flow?.codeVerifier) {
      throw new Error("OAuth flow expired — start the connection again");
    }
    return decryptString(flow.codeVerifier);
  }
}

/**
 * OAuth scope to request for a server: the preset's least-privilege scope
 * set for the connection's write scope (Slack), or undefined to fall back
 * to the provider's advertised `scopes_supported` (Close, custom).
 */
function oauthScopeForServer(server: IMcpServer): string | undefined {
  return mcpPresetOAuthScope(
    getMcpPreset(server.connectorType),
    server.writeScope,
  );
}

/**
 * Save a pre-registered (manual) OAuth client for a server — used by
 * providers that don't support Dynamic Client Registration (Slack). Stored
 * on the same encrypted field DCR uses, so `auth()` picks it up and skips
 * registration. Clears any previously issued tokens: they belonged to the
 * old client and would be rejected.
 */
export async function saveMcpOAuthClient(params: {
  server: IMcpServer;
  clientId: string;
  clientSecret?: string;
}): Promise<void> {
  const { server, clientId, clientSecret } = params;
  await McpServer.updateOne(
    { _id: server._id },
    {
      $set: {
        "oauth.clientInformation": encryptString(
          JSON.stringify({
            client_id: clientId,
            ...(clientSecret ? { client_secret: clientSecret } : {}),
          }),
        ),
      },
    },
  );
  await McpConnectionConfig.updateMany(
    { serverId: server._id },
    { $unset: { oauthTokens: "", oauthExpiresAt: "" } },
  );
  logger.info("MCP OAuth client saved", {
    serverId: server._id.toString(),
  });
}

/** Whether a server already has an OAuth client (DCR'd or manually saved). */
export async function hasMcpOAuthClient(server: IMcpServer): Promise<boolean> {
  const doc = await McpServer.findById(server._id).select("oauth").lean();
  return Boolean(doc?.oauth?.clientInformation);
}

/**
 * Begin the OAuth flow for a server/connection: discover metadata, register
 * the client (DCR) if needed, mint PKCE + state, persist the pending flow,
 * and return the authorization URL for the browser to visit.
 */
export async function startMcpOAuthFlow(params: {
  server: IMcpServer;
  configUserId: string;
  startedByUserId: string;
}): Promise<{ authorizationUrl: string }> {
  const { server, configUserId, startedByUserId } = params;
  const preset = getMcpPreset(server.connectorType);

  // Manual-client presets (Slack) can't fall back to DCR: fail with a clear
  // setup message instead of a confusing provider error.
  if (
    preset.oauth?.clientMode === "manual" &&
    !(await hasMcpOAuthClient(server))
  ) {
    throw new Error(
      `${preset.label} requires a pre-registered OAuth app — a workspace admin must save its Client ID and Client Secret first`,
    );
  }

  const provider = new MongoOAuthClientProvider(server, configUserId);
  provider.startedByUserId = startedByUserId;

  try {
    const result = await auth(provider, {
      serverUrl: server.transport.url,
      scope: oauthScopeForServer(server),
    });
    // Already authorized (valid or refreshable tokens) — no redirect needed.
    if (result === "AUTHORIZED") {
      return { authorizationUrl: "" };
    }
    throw new Error(`Unexpected auth result: ${result}`);
  } catch (error) {
    if (error instanceof RedirectRequested) {
      logger.info("MCP OAuth flow started", {
        serverId: server._id.toString(),
        configUserId,
      });
      return { authorizationUrl: error.authorizationUrl.toString() };
    }
    throw error;
  }
}

/**
 * Server id of a pending flow (by `state`), so the OAuth callback can send
 * the browser back to that server's settings modal even when the flow fails.
 */
export async function findMcpOAuthFlowServerId(
  state: string,
): Promise<string | null> {
  const flow = await McpOAuthFlow.findOne({ state }).select("serverId").lean();
  return flow?.serverId ? flow.serverId.toString() : null;
}

/**
 * Complete the flow from the OAuth callback: validate state, exchange the
 * authorization code (PKCE), persist tokens on the connection config.
 * Returns the workspace/server the flow belonged to for the UI redirect.
 */
export async function completeMcpOAuthFlow(params: {
  state: string;
  code: string;
  sessionUserId: string;
}): Promise<{ workspaceId: string; serverId: string }> {
  const { state, code, sessionUserId } = params;
  const flow = await McpOAuthFlow.findOne({ state });
  if (!flow) {
    throw new Error("OAuth flow not found or expired — try connecting again");
  }
  if (flow.startedByUserId !== sessionUserId) {
    throw new Error("This OAuth flow was started by a different user");
  }
  const server = await McpServer.findById(flow.serverId);
  if (!server) {
    throw new Error("MCP server no longer exists");
  }

  const provider = new MongoOAuthClientProvider(
    server,
    flow.configUserId,
    flow._id,
  );
  const result = await auth(provider, {
    serverUrl: server.transport.url,
    authorizationCode: code,
    scope: oauthScopeForServer(server),
  });
  if (result !== "AUTHORIZED") {
    throw new UnauthorizedError("Token exchange did not complete");
  }
  await McpOAuthFlow.deleteOne({ _id: flow._id });

  if (server.status === "created") {
    server.status = "awaiting_auth";
    await server.save();
  }
  logger.info("MCP OAuth flow completed", {
    serverId: server._id.toString(),
    configUserId: flow.configUserId,
  });
  return {
    workspaceId: server.workspaceId.toString(),
    serverId: server._id.toString(),
  };
}

/**
 * Ensure fresh OAuth tokens for a connection and return the Authorization
 * header. Refreshes (and persists) expired access tokens via the SDK's
 * `auth()`; throws UnauthorizedError when re-consent is required.
 */
export async function getMcpOAuthAuthorization(
  server: IMcpServer,
  configUserId: string,
): Promise<{ Authorization: string }> {
  const provider = new MongoOAuthClientProvider(server, configUserId);

  const tokens = await provider.tokens();
  if (!tokens) {
    throw new UnauthorizedError(
      `No ${server.name} account connected — connect it in Settings → MCP Servers`,
    );
  }

  const config = await McpConnectionConfig.findOne({
    serverId: server._id,
    userId: configUserId,
  })
    .select("oauthExpiresAt")
    .lean();
  const expiresSoon =
    typeof config?.oauthExpiresAt === "number" &&
    config.oauthExpiresAt < Date.now() + 30_000;

  if (expiresSoon && tokens.refresh_token) {
    try {
      const result = await auth(provider, {
        serverUrl: server.transport.url,
        scope: oauthScopeForServer(server),
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
          `Your ${server.name} connection expired — reconnect it in Settings → MCP Servers`,
        );
      }
      throw error;
    }
  }

  return { Authorization: `Bearer ${tokens.access_token}` };
}

export { UnauthorizedError as McpUnauthorizedError };

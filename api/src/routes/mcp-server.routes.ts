/**
 * Mako's own MCP endpoint (Streamable HTTP, stateless JSON mode).
 *
 * POST /api/mcp — one JSON-RPC exchange per request; authenticated with the
 * OAuth sign-in flow (see mcp-oauth.routes.ts) or a workspace API key
 * (`Authorization: Bearer revops_...`). Sessions and SSE resumption are
 * intentionally not supported: every request builds a fresh Server bound to
 * the credential's workspace and acting user, which keeps the endpoint
 * horizontally scalable and auditable.
 *
 * Client setup (OAuth — the client opens a browser to sign in):
 *   claude mcp add --transport http mako https://<host>/api/mcp
 *
 * Not documented in the OpenAPI surface (JSON-RPC, not REST); mounted next
 * to the public MCP preset routes in register-routes.ts.
 */
import { Hono } from "hono";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import {
  unifiedAuthMiddleware,
  isApiKeyAuth,
  isMcpOAuthAuth,
} from "../auth/unified-auth.middleware";
import { mcpResourceMetadataUrl } from "./mcp-oauth.routes";
import { requireWorkspace } from "../middleware/workspace.middleware";
import {
  hasWorkspaceApiKeyScope,
  resolveWorkspaceApiKeyScopes,
} from "../auth/api-key-scopes";
import { buildMakoMcpServer } from "../mcp/mako-mcp-server";
import { createMcpPreviewTools } from "../mcp/preview-tools";
import { StatelessMcpTransport } from "../mcp/stateless-transport";
import { ACP_MCP_CLIENT_ID } from "../auth/mcp-oauth.service";
import type { AuthEnv } from "../openapi/core";
import { loggers } from "../logging";
import { resolveAcpPlanGrants } from "../services/acp-plan-grant.service";

const logger = loggers.api("mcp-server");

/** Generous ceiling: tool calls include query execution and materialization. */
const EXCHANGE_TIMEOUT_MS = 120_000;

function jsonRpcError(id: unknown, code: number, message: string) {
  return { jsonrpc: "2.0" as const, id: id ?? null, error: { code, message } };
}

function looksLikeJsonRpc(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === "object" &&
    value !== null &&
    (value as { jsonrpc?: unknown }).jsonrpc === "2.0"
  );
}

export const mcpProtocolRoutes = new Hono<AuthEnv>();

/**
 * RFC 9728 challenge: any 401 from this endpoint advertises the protected
 * resource metadata so OAuth-capable MCP clients (Claude, Cursor, Codex)
 * can discover the sign-in flow instead of demanding a pre-shared key.
 */
mcpProtocolRoutes.use("/", async (c, next) => {
  await next();
  if (c.res.status === 401) {
    c.res.headers.set(
      "WWW-Authenticate",
      `Bearer resource_metadata="${mcpResourceMetadataUrl(c)}"`,
    );
  }
});

mcpProtocolRoutes.post(
  "/",
  unifiedAuthMiddleware,
  requireWorkspace,
  async c => {
    // Session cookies are for the browser app; external MCP clients must
    // authenticate with either the OAuth sign-in flow or a workspace API key
    // so the workspace binding is unambiguous.
    if (!isApiKeyAuth(c) && !isMcpOAuthAuth(c)) {
      return c.json(
        {
          error:
            "The MCP endpoint requires OAuth (connect this URL from your MCP " +
            "client and sign in) or a workspace API key " +
            "(Authorization: Bearer revops_..., created under Workspace " +
            "Settings → API keys).",
        },
        401,
      );
    }

    const workspaceId = c.get("workspaceId");
    const user = c.get("user");
    const apiKey = c.get("apiKey");
    if (!workspaceId) {
      return c.json({ error: "Credential is not bound to a workspace" }, 401);
    }
    const scopes = isMcpOAuthAuth(c)
      ? resolveWorkspaceApiKeyScopes(c.get("mcpOAuthScopes"))
      : resolveWorkspaceApiKeyScopes(apiKey?.scopes);
    if (!hasWorkspaceApiKeyScope(scopes, "mcp")) {
      // Agents relay this verbatim to the user, so the error is the docs:
      // say why AND how to fix it.
      const isLegacyKey = apiKey?.scopes === undefined;
      return c.json(
        {
          error: isLegacyKey
            ? "This API key was created before MCP scopes existed and cannot " +
              "use MCP. Create a new key under Workspace Settings → API keys " +
              "(new keys include read-only MCP access by default) and update " +
              "your MCP client configuration with it."
            : "This API key does not include the mcp scope. Create a new key " +
              "under Workspace Settings → API keys and use that for MCP.",
        },
        403,
      );
    }

    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(jsonRpcError(null, -32700, "Parse error"), 400);
    }

    const incoming = Array.isArray(body) ? body : [body];
    if (incoming.length === 0 || !incoming.every(looksLikeJsonRpc)) {
      return c.json(
        jsonRpcError(null, -32600, "Invalid Request: expected JSON-RPC 2.0"),
        400,
      );
    }

    // Desktop ACP attaches via a fixed OAuth client. Those sessions already
    // have a live iframe — hide headless create_preview_token / render_app.
    const acpDesktop = c.get("mcpOAuthClientId") === ACP_MCP_CLIENT_ID;
    const capabilityGrants =
      acpDesktop && user
        ? await resolveAcpPlanGrants({
            workspaceId,
            userId: String(user.id),
            agentSessionId: c.get("mcpAgentSessionId"),
          })
        : undefined;
    const mcpContext = {
      workspaceId,
      userId: user ? String(user.id) : undefined,
      scopes,
      acpDesktop,
      capabilityGrants,
    };
    const server = buildMakoMcpServer(
      mcpContext,
      acpDesktop ? undefined : createMcpPreviewTools(mcpContext),
    );
    const transport = new StatelessMcpTransport();

    try {
      await server.connect(transport);
      const responses = await transport.handle(
        incoming as unknown as JSONRPCMessage[],
        EXCHANGE_TIMEOUT_MS,
      );

      // Notification-only exchange (e.g. notifications/initialized): nothing
      // to return — 202 per the Streamable HTTP spec.
      if (responses.length === 0) {
        return c.body(null, 202);
      }
      return c.json(Array.isArray(body) ? responses : responses[0]);
    } catch (error) {
      logger.error("MCP exchange failed", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
      return c.json(jsonRpcError(null, -32603, "Internal error"), 500);
    } finally {
      await server.close().catch(() => {
        /* per-request server; nothing to clean up */
      });
    }
  },
);

// Stateless mode: no server-initiated SSE stream and no session to delete.
mcpProtocolRoutes.get("/", c =>
  c.json({ error: "This MCP server is stateless; use POST" }, 405),
);
mcpProtocolRoutes.delete("/", c =>
  c.json({ error: "This MCP server is stateless; there is no session" }, 405),
);

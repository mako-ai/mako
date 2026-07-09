/**
 * Mako's own MCP endpoint (Streamable HTTP, stateless JSON mode).
 *
 * POST /api/mcp — one JSON-RPC exchange per request; authenticated with a
 * workspace API key (`Authorization: Bearer revops_...`). Sessions and SSE
 * resumption are intentionally not supported: every request builds a fresh
 * Server bound to the key's workspace and acting user, which keeps the
 * endpoint horizontally scalable and auditable.
 *
 * Client setup:
 *   claude mcp add --transport http mako https://<host>/api/mcp \
 *     --header "Authorization: Bearer revops_..."
 *
 * Not documented in the OpenAPI surface (JSON-RPC, not REST); mounted next
 * to the public MCP preset routes in register-routes.ts.
 */
import { Hono } from "hono";
import type { JSONRPCMessage } from "@modelcontextprotocol/sdk/types.js";

import {
  unifiedAuthMiddleware,
  isApiKeyAuth,
} from "../auth/unified-auth.middleware";
import { buildMakoMcpServer } from "../mcp/mako-mcp-server";
import { StatelessMcpTransport } from "../mcp/stateless-transport";
import type { AuthEnv } from "../openapi/core";
import { loggers } from "../logging";

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

mcpProtocolRoutes.post("/", unifiedAuthMiddleware, async c => {
  // Session cookies are for the browser app; external MCP clients must
  // present a workspace API key so the workspace binding is unambiguous.
  if (!isApiKeyAuth(c)) {
    return c.json(
      {
        error:
          "The MCP endpoint requires a workspace API key: " +
          'Authorization: Bearer revops_... (create one under Workspace Settings → API keys)',
      },
      401,
    );
  }

  const workspaceId = c.get("workspaceId");
  const user = c.get("user");
  if (!workspaceId) {
    return c.json({ error: "API key is not bound to a workspace" }, 401);
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

  const server = buildMakoMcpServer({
    workspaceId,
    userId: user ? String(user.id) : undefined,
  });
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
});

// Stateless mode: no server-initiated SSE stream and no session to delete.
mcpProtocolRoutes.get("/", c =>
  c.json({ error: "This MCP server is stateless; use POST" }, 405),
);
mcpProtocolRoutes.delete("/", c =>
  c.json({ error: "This MCP server is stateless; there is no session" }, 405),
);

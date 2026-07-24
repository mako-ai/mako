/**
 * HTTP routes for the Desktop ↔ Local Agent tool bridge + mako-desktop MCP.
 */
import type { Context, Hono } from "hono";
import { desktopBridgeRegistry } from "./registry";
import { DESKTOP_MCP_PATH, handleDesktopMcpExchange } from "./mcp";

function jsonError(c: Context, message: string, status: 400 | 404 | 500) {
  return c.json({ success: false, error: message }, status);
}

export function registerDesktopBridgeRoutes(app: Hono): void {
  app.post("/desktop/bridge/hello", c => {
    desktopBridgeRegistry.touchClient();
    return c.json({ success: true, data: { ok: true } });
  });

  app.post("/desktop/bridge/claim", async c => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        waitMs?: number;
      };
      const waitMs =
        typeof body.waitMs === "number" && body.waitMs >= 0
          ? Math.min(body.waitMs, 25_000)
          : 20_000;
      const job = await desktopBridgeRegistry.claim(waitMs);
      return c.json({ success: true, data: { job } });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Desktop bridge claim failed";
      return jsonError(c, message, 500);
    }
  });

  app.post("/desktop/bridge/jobs/:id/result", async c => {
    const id = c.req.param("id");
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        ok?: boolean;
        result?: unknown;
        error?: string;
      };
      if (body.ok === false || typeof body.error === "string") {
        const ok = desktopBridgeRegistry.fail(
          id,
          body.error || "Desktop bridge job failed",
        );
        if (!ok) return jsonError(c, "Job not found", 404);
        return c.json({ success: true, data: { ok: true } });
      }
      const ok = desktopBridgeRegistry.complete(id, body.result ?? null);
      if (!ok) return jsonError(c, "Job not found", 404);
      return c.json({ success: true, data: { ok: true } });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Desktop bridge result failed";
      return jsonError(c, message, 500);
    }
  });

  app.post(DESKTOP_MCP_PATH, async c => {
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      return c.json(
        {
          jsonrpc: "2.0",
          id: null,
          error: { code: -32700, message: "Parse error" },
        },
        400,
      );
    }
    const exchange = await handleDesktopMcpExchange(body);
    if (exchange.status === 202) {
      return c.body(null, 202);
    }
    return c.json(exchange.body as Record<string, unknown>, exchange.status);
  });

  app.get(DESKTOP_MCP_PATH, c =>
    c.json({ error: "This MCP server is stateless; use POST" }, 405),
  );
}

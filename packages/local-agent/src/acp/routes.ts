/**
 * HTTP routes that expose the ACP session manager to the Mako web app.
 */
import type { Context, Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { isAcpProviderId } from "./providers";
import { acpSessionManager } from "./manager";
import type {
  CreateAcpSessionRequest,
  PermissionResponseRequest,
  PromptAcpSessionRequest,
  SetAcpSessionConfigRequest,
} from "./types";

function jsonError(c: Context, message: string, status: 400 | 404 | 500) {
  return c.json({ success: false, error: message }, status);
}

export function registerAcpRoutes(app: Hono): void {
  app.get("/acp/status", c => {
    return c.json({ success: true, data: acpSessionManager.getStatus() });
  });

  app.post("/acp/adapters/:providerId/ensure", async c => {
    try {
      const raw = c.req.param("providerId");
      if (!isAcpProviderId(raw)) {
        return jsonError(c, `Unknown ACP provider: ${raw}`, 400);
      }
      const body = (await c.req.json().catch(() => ({}))) as {
        force?: boolean;
      };
      const result = await acpSessionManager.ensureAdapter(raw, {
        force: Boolean(body.force),
      });
      return c.json({ success: true, data: result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update adapter";
      return jsonError(c, message, 400);
    }
  });

  app.post("/acp/providers/:providerId/warm-models", async c => {
    try {
      const raw = c.req.param("providerId");
      if (!isAcpProviderId(raw)) {
        return jsonError(c, `Unknown ACP provider: ${raw}`, 400);
      }
      const result = await acpSessionManager.ensureProviderModels(raw);
      return c.json({ success: true, data: result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to warm models";
      return jsonError(c, message, 400);
    }
  });

  app.get("/acp/sessions", c => {
    return c.json({
      success: true,
      data: acpSessionManager.listSessions(),
    });
  });

  app.get("/acp/sessions/:id", c => {
    const session = acpSessionManager.getSession(c.req.param("id"));
    if (!session) {
      return jsonError(c, "Session not found", 404);
    }
    return c.json({ success: true, data: session });
  });

  app.post("/acp/authenticate", async c => {
    try {
      const body = (await c.req.json().catch(() => ({}))) as {
        providerId?: string;
        methodId?: string;
      };
      const rawProvider = String(body.providerId || "claude");
      const providerId = isAcpProviderId(rawProvider) ? rawProvider : "claude";
      const result = await acpSessionManager.authenticate(
        providerId,
        body.methodId,
      );
      return c.json({ success: true, data: result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Authentication failed";
      return jsonError(c, message, 400);
    }
  });

  app.post("/acp/sessions", async c => {
    try {
      const body = (await c.req.json()) as CreateAcpSessionRequest;
      const session = await acpSessionManager.createSession(body || {});
      return c.json({ success: true, data: session });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to create session";
      return jsonError(c, message, 400);
    }
  });

  app.post("/acp/sessions/:id/prompt", async c => {
    const sessionId = c.req.param("id");
    try {
      const body = (await c.req.json()) as PromptAcpSessionRequest;
      const text =
        typeof body?.text === "string"
          ? body.text
          : Array.isArray(body?.content)
            ? body.content
                .map(block => {
                  if (
                    block &&
                    typeof block === "object" &&
                    "type" in block &&
                    (block as { type: string }).type === "text" &&
                    "text" in block
                  ) {
                    return String((block as { text: string }).text);
                  }
                  return "";
                })
                .join("")
            : "";
      const result = await acpSessionManager.prompt(sessionId, text);
      return c.json({ success: true, data: result });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Prompt failed";
      const status = message.includes("Unknown") ? 404 : 400;
      return jsonError(c, message, status);
    }
  });

  app.post("/acp/sessions/:id/cancel", async c => {
    try {
      await acpSessionManager.cancel(c.req.param("id"));
      return c.json({ success: true, data: { cancelled: true } });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Cancel failed";
      return jsonError(c, message, 400);
    }
  });

  app.post("/acp/sessions/:id/config", async c => {
    try {
      const body = (await c.req.json()) as SetAcpSessionConfigRequest;
      if (
        body?.value === undefined ||
        body?.value === null ||
        (typeof body.value !== "string" && typeof body.value !== "boolean")
      ) {
        return jsonError(c, "value is required", 400);
      }
      const session = await acpSessionManager.setSessionConfig(
        c.req.param("id"),
        {
          configId: body.configId,
          value: body.value,
        },
      );
      return c.json({ success: true, data: session });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Failed to update session config";
      const status = message.includes("Unknown") ? 404 : 400;
      return jsonError(c, message, status);
    }
  });

  app.post("/acp/sessions/:id/permissions/:requestId", async c => {
    try {
      const body = (await c.req.json()) as PermissionResponseRequest;
      acpSessionManager.respondPermission(
        c.req.param("id"),
        c.req.param("requestId"),
        body || { outcome: "cancelled" },
      );
      return c.json({ success: true, data: { ok: true } });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Permission response failed";
      return jsonError(c, message, 400);
    }
  });

  app.delete("/acp/sessions/:id", async c => {
    await acpSessionManager.closeSession(c.req.param("id"));
    return c.json({ success: true, data: { closed: true } });
  });

  app.get("/acp/sessions/:id/events", async c => {
    const sessionId = c.req.param("id");
    const session = acpSessionManager.getSession(sessionId);
    if (!session) {
      return jsonError(c, "Session not found", 404);
    }

    return streamSSE(c, async stream => {
      let closed = false;

      // Heartbeat so proxies / browsers keep the stream alive.
      const heartbeat = setInterval(() => {
        if (closed) return;
        void stream.writeSSE({
          event: "ping",
          data: JSON.stringify({ at: new Date().toISOString() }),
        });
      }, 15000);

      // Replay prior turns, then keep streaming live updates. This is what
      // rebuilds the Coding Agents transcript after a refresh / re-open.
      const unsubscribe = acpSessionManager.subscribeWithReplay(
        sessionId,
        event => {
          if (closed) return;
          void stream.writeSSE({
            event: event.type,
            data: JSON.stringify(event),
          });
        },
      );

      await stream.writeSSE({
        event: "status",
        data: JSON.stringify({
          type: "status",
          sessionId,
          message: "subscribed",
          at: new Date().toISOString(),
        }),
      });

      // Keep the handler open until the client disconnects.
      await new Promise<void>(resolve => {
        stream.onAbort(() => {
          closed = true;
          clearInterval(heartbeat);
          unsubscribe();
          resolve();
        });
      });
    });
  });
}

/**
 * Workspace realtime push channel (SSE)
 *
 * Route classification: authenticated + workspace-scoped, SESSION AUTH ONLY.
 * The browser connects with native `EventSource`, which cannot send custom
 * headers — cookie/session auth works untouched, API keys cannot be used
 * here (programmatic consumers poll over normal HTTP instead).
 *
 * Delivery semantics are poke-then-pull (see realtime.service.ts): events
 * carry hints (`consoleId` + `draftRevision`), clients pull authoritative
 * data over normal HTTP when stale. Dropped connections are harmless — the
 * client's reconnect handler re-syncs revisions, so this stream needs no
 * replay/backfill.
 */
import { Hono } from "hono";
import { streamSSE } from "hono/streaming";
import { Types } from "mongoose";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { workspaceService } from "../services/workspace.service";
import {
  subscribeToWorkspaceEvents,
  type RealtimeEvent,
} from "../services/realtime.service";
import {
  touchRealtimePresence,
  clearRealtimePresence,
} from "../services/realtime-presence.service";
import { loggers, enrichContextWithWorkspace } from "../logging";

const logger = loggers.api("realtime");

/** Keep-alive interval — defeats proxy idle timeouts (Cloud Run, nginx). */
const HEARTBEAT_INTERVAL_MS = 25_000;

export const realtimeRoutes = new Hono();

realtimeRoutes.use("*", unifiedAuthMiddleware);

// GET /api/workspaces/:workspaceId/realtime?clientId=<per-tab-id>
realtimeRoutes.get("/", async (c: AuthenticatedContext) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId || !Types.ObjectId.isValid(workspaceId)) {
    return c.json({ success: false, error: "Invalid workspace ID" }, 400);
  }

  const user = c.get("user");
  if (user) {
    const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
    if (!hasAccess) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }
  } else {
    // EventSource cannot carry API-key headers; API-key principals have no
    // browser tab to push to. Session auth only, by design.
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  enrichContextWithWorkspace(workspaceId);

  const clientId = (c.req.query("clientId") || "").slice(0, 64);

  return streamSSE(c, async stream => {
    let closed = false;
    let unsubscribe: (() => Promise<void>) | null = null;

    const cleanup = async () => {
      if (closed) return;
      closed = true;
      void clearRealtimePresence(workspaceId, clientId);
      if (unsubscribe) {
        await unsubscribe().catch(() => undefined);
      }
    };

    stream.onAbort(() => {
      void cleanup();
    });

    try {
      unsubscribe = await subscribeToWorkspaceEvents(
        workspaceId,
        (event: RealtimeEvent) => {
          if (closed) return;
          void stream
            .writeSSE({ event: "message", data: JSON.stringify(event) })
            .catch(() => void cleanup());
        },
      );

      // Presence: lets the agent pipeline know a browser is attached (used
      // by the "no client attached" tool fallback). Best-effort.
      void touchRealtimePresence(workspaceId, clientId, user.id);

      await stream.writeSSE({
        event: "hello",
        data: JSON.stringify({ clientId }),
      });

      logger.debug("Realtime client connected", { workspaceId, clientId });

      // Heartbeat loop doubles as the connection lifetime: it exits when the
      // client goes away (write failure or abort).
      while (!closed) {
        await stream.sleep(HEARTBEAT_INTERVAL_MS);
        if (closed) break;
        try {
          await stream.writeSSE({ event: "ping", data: String(Date.now()) });
        } catch {
          break;
        }
        void touchRealtimePresence(workspaceId, clientId, user.id);
      }
    } finally {
      await cleanup();
      logger.debug("Realtime client disconnected", { workspaceId, clientId });
    }
  });
});

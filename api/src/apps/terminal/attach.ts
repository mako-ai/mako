/**
 * The terminal WebSocket: caught on the raw http.Server, authorized like the
 * API (session cookie, workspace member, write access), then attached.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerType } from "@hono/node-server";
import { WebSocketServer } from "ws";
import { loggers } from "../../logging";
import { parseEntityId } from "../../database/pg/id-codec";
import { type IAppProject } from "../../database/workspace-schema";
import {
  appsMetadataRepo,
  toAppProjectCompat,
} from "../../repositories/apps-metadata";
import { sessionManager } from "../../auth/session";
import { workspaceService } from "../../services/workspace.service";
import { canWriteResource } from "../../utils/resource-acl";
import { synthesizeProjectFromFolder } from "../worktree.service";
import { startSession } from "./start";

const logger = loggers.api("apps-terminal");

const PATH_RE = /^\/api\/workspaces\/([^/]+)\/apps\/([^/]+)\/terminal(\?.*)?$/;

/** Control messages are the one thing a byte stream cannot express. */
export interface ResizeMessage {
  type: "resize";
  cols: number;
  rows: number;
}

function parseCookies(header: string | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of (header ?? "").split(";")) {
    const eq = part.indexOf("=");
    if (eq === -1) continue;
    out[part.slice(0, eq).trim()] = decodeURIComponent(
      part.slice(eq + 1).trim(),
    );
  }
  return out;
}

/**
 * Resolve the caller and the app, or return null.
 *
 * A terminal is write access by definition — you can run anything in it — so
 * it is gated on `canWriteResource`, not on read.
 */
async function authorize(
  req: IncomingMessage,
  workspaceId: string,
  appRef: string,
): Promise<{ project: IAppProject; userId: string } | null> {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies["auth_session"];
  if (!sessionId) return null;

  const { user } = await sessionManager.validateSession(sessionId);
  if (!user) return null;
  if (!parseEntityId(workspaceId)) return null;

  const ref = appRef.replace(/^apps\//, "");
  const projectRec = parseEntityId(ref)
    ? await appsMetadataRepo.findProjectById(ref, workspaceId)
    : await appsMetadataRepo.findProjectBySlug(workspaceId, ref);
  const project =
    (projectRec ? toAppProjectCompat(projectRec) : null) ??
    (await synthesizeProjectFromFolder(workspaceId, ref));
  if (!project) return null;

  const member = await workspaceService.getMember(workspaceId, user.id);
  const role = member?.role;
  if (!canWriteResource(project, user.id, role)) return null;
  return { project: project as IAppProject, userId: user.id };
}

export function attachAppsTerminalWs(serverType: ServerType): void {
  // @hono/node-server's ServerType is a union including HTTP/2 variants, which
  // do not emit "upgrade" the HTTP/1.1 way. This app only runs the plain form.
  const server = serverType as Server;
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = PATH_RE.exec(req.url ?? "");
    if (!match) return; // Not ours — leave it for any other upgrade handler.
    const [, workspaceId, appRef, query] = match;
    // VS Code-style multiple terminals: each tab is its own PTY, addressed by
    // a client-chosen id. Absent (older clients) = the first tab.
    const params = new URLSearchParams((query ?? "").replace(/^\?/, ""));
    const termId = params.get("term") ?? "1";
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(termId)) {
      socket.write("HTTP/1.1 400 Bad Request\r\n\r\n");
      socket.destroy();
      return;
    }
    // The client knows its size before it connects; creating the pty at
    // that size (instead of a 2s-lived 80x24) keeps the very first output —
    // the prompt, a replayed recording — from painting at the wrong width.
    const clamp = (v: string | null, lo: number, hi: number, dflt: number) => {
      const n = Number(v);
      return Number.isInteger(n) && n >= lo && n <= hi ? n : dflt;
    };
    const initialCols = clamp(params.get("cols"), 20, 500, 80);
    const initialRows = clamp(params.get("rows"), 5, 300, 24);
    // A tab the client just created has no history to replay; saying so
    // saves the prefill exec round-trip on the open of every new terminal.
    const fresh = params.get("fresh") === "1";

    void (async () => {
      // A failed lookup is not a failed login. Collapsing both into 401 told
      // the client its session was bad when the truth was a transient error —
      // a worktree being rebuilt after its sandbox expired, say — and 401 is
      // the one status a client should NOT simply retry.
      let auth: Awaited<ReturnType<typeof authorize>> = null;
      try {
        auth = await authorize(req, workspaceId, appRef);
      } catch (error) {
        logger.error("Terminal authorization failed", {
          error: error instanceof Error ? error.message : String(error),
        });
        socket.write("HTTP/1.1 503 Service Unavailable\r\n\r\n");
        socket.destroy();
        return;
      }
      if (!auth) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => {
        void startSession(ws, auth.project, auth.userId, termId, {
          initialCols,
          initialRows,
          fresh,
        }).catch(error => {
          logger.error("Terminal session failed to start", { error });
          ws.close(1011, "terminal failed to start");
        });
      });
    })();
  });

  logger.info("Apps terminal WebSocket attached");
}

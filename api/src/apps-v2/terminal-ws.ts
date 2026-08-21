/**
 * Interactive terminal for Apps v2, over a WebSocket.
 *
 * The old terminal ran one command and printed the result. That is fine for
 * `ls`, and useless for everything a shell is actually for: a prompt, ctrl-C,
 * watching a build, an editor, anything that asks a question. This attaches a
 * real PTY in the sandbox and streams it, so the pane behaves like a terminal
 * because it IS one.
 *
 * Bytes both ways, no framing of our own — xterm.js and the shell already
 * agree on a protocol, and inventing a second one on top would only be
 * something else to get wrong. The single exception is window size, which has
 * no in-band representation: those arrive as a small JSON control message.
 *
 * A WebSocket upgrade has to be caught on the raw http.Server before Hono sees
 * it, the same way the old dev-preview proxy did. Unlike that proxy, nothing
 * of the tenant's runs here — this process only moves bytes between a socket
 * and a microVM.
 */
import type { IncomingMessage, Server } from "node:http";
import type { Duplex } from "node:stream";
import type { ServerType } from "@hono/node-server";
import { WebSocketServer, type WebSocket } from "ws";
import { Types } from "mongoose";
import { loggers } from "../logging";
import { AppProjectV2, type IAppProjectV2 } from "../database/workspace-schema";
import { sessionManager } from "../auth/session";
import { workspaceService } from "../services/workspace.service";
import { canWriteResource } from "../utils/resource-acl";
import { getSandboxProvider } from "./sandbox/provider";
import {
  ensureWorktree,
  synthesizeProjectFromFolder,
} from "./worktree.service";

const logger = loggers.api("apps-v2-terminal");

const PATH_RE =
  /^\/api\/workspaces\/([^/]+)\/apps-v2\/([^/]+)\/terminal(\?.*)?$/;

/** Control messages are the one thing a byte stream cannot express. */
interface ResizeMessage {
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
): Promise<{ project: IAppProjectV2; userId: string } | null> {
  const cookies = parseCookies(req.headers.cookie);
  const sessionId = cookies["auth_session"];
  if (!sessionId) return null;

  const { user } = await sessionManager.validateSession(sessionId);
  if (!user) return null;
  if (!Types.ObjectId.isValid(workspaceId)) return null;

  const ref = appRef.replace(/^apps\//, "");
  const project =
    (Types.ObjectId.isValid(ref)
      ? await AppProjectV2.findOne({
          _id: new Types.ObjectId(ref),
          workspaceId: new Types.ObjectId(workspaceId),
        })
      : await AppProjectV2.findOne({
          slug: ref,
          workspaceId: new Types.ObjectId(workspaceId),
        })) ?? (await synthesizeProjectFromFolder(workspaceId, ref));
  if (!project) return null;

  const member = await workspaceService.getMember(workspaceId, user.id);
  const role = member?.role;
  if (!canWriteResource(project, user.id, role)) return null;
  return { project: project as IAppProjectV2, userId: user.id };
}

export function attachAppsV2TerminalWs(serverType: ServerType): void {
  // @hono/node-server's ServerType is a union including HTTP/2 variants, which
  // do not emit "upgrade" the HTTP/1.1 way. This app only runs the plain form.
  const server = serverType as Server;
  const wss = new WebSocketServer({ noServer: true });

  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const match = PATH_RE.exec(req.url ?? "");
    if (!match) return; // Not ours — leave it for any other upgrade handler.
    const [, workspaceId, appRef] = match;

    void (async () => {
      const auth = await authorize(req, workspaceId, appRef).catch(() => null);
      if (!auth) {
        socket.write("HTTP/1.1 401 Unauthorized\r\n\r\n");
        socket.destroy();
        return;
      }
      wss.handleUpgrade(req, socket, head, ws => {
        void startSession(ws, auth.project, auth.userId).catch(error => {
          logger.error("Terminal session failed to start", { error });
          ws.close(1011, "terminal failed to start");
        });
      });
    })();
  });

  logger.info("Apps v2 terminal WebSocket attached");
}

async function startSession(
  ws: WebSocket,
  project: IAppProjectV2,
  userId: string,
): Promise<void> {
  const handle = await ensureWorktree(project, userId);
  const provider = getSandboxProvider();

  const terminal = await provider.openTerminal(
    { hostDir: handle.sessionDir, sessionKey: handle.doc._id.toString() },
    {
      cwd: handle.appRoot,
      cols: 80,
      rows: 24,
      onData: data => {
        if (ws.readyState === ws.OPEN) ws.send(data);
      },
    },
  );

  ws.on("message", (raw: Buffer, isBinary: boolean) => {
    // Control messages arrive as text; everything else is keystrokes.
    if (!isBinary) {
      const text = raw.toString("utf8");
      if (text.startsWith("{")) {
        try {
          const msg = JSON.parse(text) as ResizeMessage;
          if (msg.type === "resize" && msg.cols > 0 && msg.rows > 0) {
            void terminal.resize(msg.cols, msg.rows).catch(() => undefined);
            return;
          }
        } catch {
          // Not a control message after all — fall through and type it.
        }
      }
      void terminal
        .write(new TextEncoder().encode(text))
        .catch(() => undefined);
      return;
    }
    void terminal.write(new Uint8Array(raw)).catch(() => undefined);
  });

  const shutdown = () => {
    void terminal.close().catch(() => undefined);
  };
  ws.on("close", shutdown);
  ws.on("error", shutdown);

  logger.info("Apps v2 terminal session opened", {
    projectId: project._id.toString(),
    appRoot: handle.appRoot,
  });
}

/**
 * WebSocket upgrade proxy for apps-v2 dev previews (vite's HMR client).
 *
 * Hono routes only handle regular HTTP requests — a WebSocket upgrade must
 * be intercepted at the raw `http.Server` level, before Hono ever sees it.
 * Security model matches the rest of preview.service.ts: the unguessable,
 * short-lived preview token is the sole credential (no cookies/session), so
 * proxying purely on token validity here is consistent with the HTTP asset
 * route's own model.
 */
import type { IncomingMessage, Server } from "node:http";
import net from "node:net";
import type { Duplex } from "node:stream";
import type { ServerType } from "@hono/node-server";
import { resolvePreviewGrant } from "./preview.service";
import { loggers } from "../logging";

const logger = loggers.api("apps-v2-dev-preview-ws");

const TOKEN_PATH_RE = /^\/api\/apps-v2-preview\/([^/]+)(\/.*)?$/;

export function attachAppsV2DevPreviewWsProxy(serverType: ServerType): void {
  // @hono/node-server's ServerType is a union with the HTTP/2 server
  // variants (which don't emit "upgrade" the HTTP/1.1 way); this app only
  // ever runs the plain server() form, so narrowing is safe here.
  const server = serverType as Server;
  server.on("upgrade", (req: IncomingMessage, socket: Duplex, head: Buffer) => {
    const url = req.url ?? "";
    const match = TOKEN_PATH_RE.exec(url);
    if (!match) {
      socket.destroy();
      return;
    }
    const [, token] = match;
    const grant = resolvePreviewGrant(token);
    if (!grant?.devPort) {
      socket.destroy();
      return;
    }

    const target = net.connect(grant.devPort, "127.0.0.1", () => {
      // Forward the FULL original path (token prefix included) — vite was
      // started with --base=/api/apps-v2-preview/<token>/ (see
      // dev-server.service.ts), so its HMR websocket server expects
      // connections at that exact prefix, same reasoning as the HTTP proxy.
      const lines = [`GET ${url} HTTP/1.1`];
      for (let i = 0; i < req.rawHeaders.length; i += 2) {
        const name = req.rawHeaders[i];
        if (name.toLowerCase() === "host") continue;
        lines.push(`${name}: ${req.rawHeaders[i + 1]}`);
      }
      lines.push(`Host: 127.0.0.1:${grant.devPort}`, "", "");
      target.write(lines.join("\r\n"));
      if (head && head.length > 0) target.write(head);
      target.pipe(socket);
      socket.pipe(target);
    });

    target.on("error", err => {
      logger.debug("Dev preview WS proxy target error", {
        error: err.message,
      });
      socket.destroy();
    });
    socket.on("error", () => target.destroy());
  });
}

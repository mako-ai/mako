import type { Context, Next } from "hono";
import {
  appFrameAncestors,
  appIdFromHost,
  requestHost,
} from "../apps/app-origin";
import { resolvePreviewGrant } from "../apps/preview.service";

/**
 * What an app host (`<appId>.<apps domain>`, app-origin.ts) may serve:
 * exactly one app's published files, through a token minted for that app.
 *
 * App code on that origin runs with `allow-same-origin`, so anything this
 * host answers is readable by it. The gate makes the answer small:
 *
 * - Only `/api/apps-preview/<pub token>[/…]`. Login, the REST API, MCP, the
 *   SPA: all 404, so the apps domain can never become a second app.mako.ai.
 * - Plus `/__mako/ping`: a constant answer Mako's client fetches (CORS,
 *   no credentials) before framing an app here. A corporate proxy that
 *   blocks the apps domain (Zscaler and the like) answers that fetch with
 *   its own page and no CORS header, so the client falls back to Mako's
 *   origin instead of framing the proxy's block page (app-frame.ts).
 * - Only a published (`pub.`) token whose app is THIS host's app. A token
 *   for app B on app A's host would run B's code inside A's origin, next to
 *   A's storage; it 404s. (Static build previews are per-instance and stay
 *   on Mako's origin.)
 * - Responses carry `frame-ancestors <Mako>` and no X-Frame-Options (which
 *   would forbid Mako framing it), and never set a cookie or allow
 *   credentialed CORS.
 *
 * Registered FIRST in index.ts: Hono runs the after-`next()` half of the
 * outermost middleware last, so these headers win over secureHeaders'.
 */
export async function appsHostGate(c: Context, next: Next) {
  const appId = appIdFromHost(requestHost(name => c.req.header(name)));
  if (!appId) return next();

  if (c.req.path === APP_HOST_PING_PATH) {
    const headers = new Headers({
      "Content-Type": "application/json",
      "Cache-Control": "no-store",
    });
    const client = clientOrigin();
    if (client) headers.set("Access-Control-Allow-Origin", client);
    return new Response(JSON.stringify({ ok: true }), {
      status: 200,
      headers: appHostHeaders(headers),
    });
  }

  if (!allowedOnAppHost(c.req.path, appId)) {
    return new Response(
      JSON.stringify({ success: false, error: "Not found" }),
      {
        status: 404,
        headers: appHostHeaders(
          new Headers({
            "Content-Type": "application/json",
            "Cache-Control": "no-store",
          }),
        ),
      },
    );
  }
  await next();
  const res = c.res;
  const rewritten = new Response(res.body, {
    status: res.status,
    statusText: res.statusText,
    headers: appHostHeaders(new Headers(res.headers)),
  });
  // Hono's `res` setter merges the PREVIOUS response's headers back in
  // (X-Frame-Options, Set-Cookie included); clearing it first stops that.
  c.res = undefined;
  c.res = rewritten;
}

const PREFIX = "/api/apps-preview/";

/** The reachability probe an app host answers without a token. */
export const APP_HOST_PING_PATH = "/__mako/ping";

function clientOrigin(): string | null {
  try {
    return process.env.CLIENT_URL
      ? new URL(process.env.CLIENT_URL).origin
      : null;
  } catch {
    return null;
  }
}

/** True when `path` is a published asset URL for `appId`'s own token. */
export function allowedOnAppHost(path: string, appId: string): boolean {
  if (!path.startsWith(PREFIX)) return false;
  let token: string;
  try {
    token = decodeURIComponent(path.slice(PREFIX.length).split("/")[0]);
  } catch {
    return false;
  }
  if (!token.startsWith("pub.")) return false;
  const grant = resolvePreviewGrant(token);
  return !!grant && grant.projectId.toLowerCase() === appId;
}

function appHostHeaders(headers: Headers): Headers {
  headers.delete("X-Frame-Options");
  headers.delete("Set-Cookie");
  headers.delete("Access-Control-Allow-Credentials");
  // The app's own documents may be framed by Mako, and by nobody else.
  headers.set(
    "Content-Security-Policy",
    `frame-ancestors ${appFrameAncestors()}`,
  );
  // Nothing on this host should ever carry the token to another site.
  headers.set("Referrer-Policy", "no-referrer");
  return headers;
}

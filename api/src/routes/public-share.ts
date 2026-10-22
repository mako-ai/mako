/**
 * Public share consumption routes — intentionally public (token-gated).
 *
 * Classification: Intentionally public. Access is gated by an unguessable
 * share token (and optionally a password). Anonymous viewers see the app's
 * published deployment and its materialized snapshot artifacts; live
 * re-execution is only reachable when the owner opts in (`allowLiveQueries`).
 *
 *   GET  /api/share/:token            — share metadata (+passwordRequired)
 *   POST /api/share/:token/unlock     — verify password, set signed cookie
 *   GET  /api/share/:token/content    — shared app entry metadata
 *   GET  /api/share/:token/app/*      — the app's published deployment files
 *
 * With APPS_ORIGIN_BASE set, /content also hands out `appUrl`: the app on
 * its own origin (`https://<appId>.makousercontent.com/api/apps-preview/
 * pub.<token>/`), under a published token the SHARE minted. The share page
 * frames that URL instead of navigating to /app/, so the browser cache
 * works (apps.md §30-31). Everything the app then fetches goes to the app
 * host's token route, which applies the share's rules to share tokens
 * (`refreshForShareGrant`).
 */

import { withQueryLabels } from "../services/bigquery-labels";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { OPEN_RESPONSES, createRouter } from "../openapi/core";
import { loggers } from "../logging";
import { serverTiming, timed } from "../middleware/server-timing";
import {
  refreshBindingHttp,
  refreshBindingProgress,
} from "../apps/binding-refresh";
import { wantsBindingProgress } from "../apps/binding-progress";
import { serveDeploymentFile } from "../apps/deployment.service";
import {
  APP_DOCUMENT_SANDBOX,
  sandboxAppDocument,
} from "../apps/app-document-sandbox";
import {
  anonIdFromCookie,
  classifyUserAgent,
  recordServedOpen,
  servedOpenSource,
} from "../apps/app-usage.service";
import { appOriginFor, tokenWindowMs } from "../apps/app-origin";
import {
  mintPublishedGrant,
  shareFingerprint,
  type PreviewGrant,
} from "../apps/preview.service";
import { AppProject, type IAppProject } from "../database/workspace-schema";
import {
  findShareByToken,
  isOpenShare,
  shareImageFor,
} from "../services/share-og.service";

const logger = loggers.api("public-share");

const app = createRouter();

const TokenParam = z.object({
  token: z.string().openapi({ param: { name: "token", in: "path" } }),
});
const OptionalJsonBody = {
  required: false,
  content: {
    "application/json": { schema: z.record(z.string(), z.any()) },
  },
};

/** How long an unlock cookie stays valid. */
const UNLOCK_TTL_MS = 12 * 60 * 60 * 1000;
/** Minimum delay between anonymous refresh triggers per app binding. */
export const PUBLIC_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
/** Password attempts per token+IP within the window. */
const UNLOCK_MAX_ATTEMPTS = 10;
const UNLOCK_WINDOW_MS = 15 * 60 * 1000;

// "app" is a git-backed app's built deployment (§13) — the only shareable
// resource type.
type SharedResource = { type: "app"; doc: IAppProject };

async function findByToken(token: string): Promise<SharedResource | null> {
  // Tokens are readable slugs (possibly short) or legacy random strings.
  const app = await findShareByToken(token);
  if (app) return { type: "app", doc: app };
  return null;
}

// ── Password unlock cookie (HMAC-signed, stateless) ──

function getShareSecret(): string {
  const secret = process.env.SESSION_SECRET;
  if (!secret) throw new Error("SESSION_SECRET is required for public shares");
  return secret;
}

function signUnlock(token: string, expiresAt: number): string {
  return crypto
    .createHmac("sha256", getShareSecret())
    .update(`share-unlock:${token}:${expiresAt}`)
    .digest("base64url");
}

function unlockCookieName(token: string): string {
  // Hash so the cookie name stays short and free of unexpected characters.
  return `mako_share_${crypto.createHash("sha256").update(token).digest("hex").slice(0, 16)}`;
}

function hasValidUnlock(c: Context, token: string): boolean {
  const raw = getCookie(c, unlockCookieName(token));
  if (!raw) return false;
  const [expStr, sig] = raw.split(".");
  const expiresAt = Number(expStr);
  if (!Number.isFinite(expiresAt) || expiresAt < Date.now()) return false;
  const expected = signUnlock(token, expiresAt);
  try {
    return crypto.timingSafeEqual(Buffer.from(sig), Buffer.from(expected));
  } catch {
    return false;
  }
}

// ── Unlock grant in the URL path ──
//
// A shared app's document is CSP-sandboxed (see SHARE_APP_SANDBOX), so its
// origin is opaque and its own requests (module scripts, `__data/*`, the
// refresh POST) carry no cookies, the unlock cookie included. The document
// navigation still does: when the cookie authorizes it, the served HTML gets
// a `<base>` pointing at `/api/share/<token>/u/<grant>/`, and every relative
// request the app makes resolves under the grant. The address bar keeps the
// cookie-gated URL, so copying it never copies the grant.
//
// The grant is the cookie's own expiry signed for a DIFFERENT purpose, so a
// grant cannot pose as a cookie, nor a cookie as a grant, and a grant never
// outlives the unlock that minted it.

function signUnlockGrant(token: string, expiresAt: number): string {
  return crypto
    .createHmac("sha256", getShareSecret())
    .update(`share-unlock-url:${token}:${expiresAt}`)
    .digest("base64url");
}

function unlockExpiry(c: Context, token: string): number | null {
  if (!hasValidUnlock(c, token)) return null;
  const raw = getCookie(c, unlockCookieName(token)) ?? "";
  return Number(raw.split(".")[0]);
}

/** The grant segment for this request's unlock cookie, or null. */
export function unlockGrantFor(c: Context, token: string): string | null {
  const expiresAt = unlockExpiry(c, token);
  return expiresAt ? `${expiresAt}.${signUnlockGrant(token, expiresAt)}` : null;
}

export function isValidUnlockGrant(token: string, grant: string): boolean {
  const [expStr, sig] = grant.split(".");
  const expiresAt = Number(expStr);
  if (!sig || !Number.isFinite(expiresAt) || expiresAt < Date.now()) {
    return false;
  }
  const expected = Buffer.from(signUnlockGrant(token, expiresAt));
  const actual = Buffer.from(sig);
  return (
    expected.length === actual.length &&
    crypto.timingSafeEqual(expected, actual)
  );
}

/**
 * The shared app on its own origin, or null when per-app origins are off
 * (then the share page navigates to /app/ exactly as before) or there is
 * nothing to serve. Called only after the unlock gate.
 *
 * The token is a published grant scoped to this app and its published
 * commit, carrying the share's fingerprint instead of a viewer. It is
 * stable for a window (app-origin.ts), so every visit inside the window,
 * by anyone, gets the same URLs and the browser cache can answer them. A
 * password share's token never outlives the visitor's unlock (12 h).
 */
function shareAppUrl(
  c: Context,
  token: string,
  resource: SharedResource,
): string | null {
  const project = resource.doc;
  const sha = project.publishedSha;
  if (!sha) return null;
  const projectId = project._id.toString();
  const origin = appOriginFor(projectId);
  if (!origin) return null;
  let notAfter: number | undefined;
  if (passwordRequired(resource)) {
    const unlockedUntil = unlockExpiry(c, token);
    if (!unlockedUntil) return null;
    notAfter = unlockedUntil;
  }
  const grant = mintPublishedGrant({
    workspaceId: project.workspaceId.toString(),
    projectId,
    sha,
    share: shareFingerprint(token),
    stableWindowMs: tokenWindowMs(),
    ...(notAfter !== undefined ? { notAfter } : {}),
  });
  return `${origin}/api/apps-preview/${encodeURIComponent(grant.token)}/`;
}

function passwordRequired(resource: SharedResource): boolean {
  return !!resource.doc.publicShare?.passwordHash;
}

function requireUnlock(c: Context, token: string, resource: SharedResource) {
  if (!passwordRequired(resource)) return null;
  if (hasValidUnlock(c, token)) return null;
  return c.json(
    { success: false, error: "Password required", code: "PASSWORD_REQUIRED" },
    401,
  );
}

// ── Unlock rate limiting (in-memory, per token+IP) ──

const unlockAttempts = new Map<string, { count: number; resetAt: number }>();

function isUnlockRateLimited(key: string): boolean {
  const now = Date.now();
  const entry = unlockAttempts.get(key);
  if (!entry || entry.resetAt < now) {
    unlockAttempts.set(key, { count: 1, resetAt: now + UNLOCK_WINDOW_MS });
    return false;
  }
  entry.count += 1;
  if (unlockAttempts.size > 10_000) {
    for (const [k, v] of unlockAttempts) {
      if (v.resetAt < now) unlockAttempts.delete(k);
    }
  }
  return entry.count > UNLOCK_MAX_ATTEMPTS;
}

function clientIp(c: Context): string {
  return (
    c.req.header("x-forwarded-for")?.split(",")[0]?.trim() ||
    c.req.header("x-real-ip") ||
    "unknown"
  );
}

// ── Routes ──

// GET /:token — public metadata (safe before password unlock)
app.openapi(
  createRoute({
    method: "get",
    path: "/{token}",
    tags: ["Public Shares"],
    summary: "Get public share metadata",
    security: [],
    request: { params: TokenParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const token = c.req.param("token") as string;
      const resource = await findByToken(token);
      if (!resource) {
        return c.json({ success: false, error: "Share link not found" }, 404);
      }
      return c.json({
        success: true,
        data: {
          type: resource.type,
          title: resource.doc.title,
          passwordRequired: passwordRequired(resource),
          unlocked: !passwordRequired(resource) || hasValidUnlock(c, token),
        },
      });
    } catch (error) {
      logger.error("Error fetching share metadata", { error });
      return c.json({ success: false, error: "Failed to load share" }, 500);
    }
  },
);

// POST /:token/unlock — verify password, set signed HttpOnly cookie
app.openapi(
  createRoute({
    method: "post",
    path: "/{token}/unlock",
    tags: ["Public Shares"],
    summary: "Unlock a password-protected share",
    security: [],
    request: { params: TokenParam, body: OptionalJsonBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const token = c.req.param("token") as string;
      const resource = await findByToken(token);
      if (!resource) {
        return c.json({ success: false, error: "Share link not found" }, 404);
      }
      if (!passwordRequired(resource)) {
        return c.json({ success: true, data: { unlocked: true } });
      }

      const rlKey = `${token}:${clientIp(c)}`;
      if (isUnlockRateLimited(rlKey)) {
        return c.json(
          { success: false, error: "Too many attempts. Try again later." },
          429,
        );
      }

      const body = await c.req.json().catch(() => ({}));
      const password = typeof body?.password === "string" ? body.password : "";
      const hash = resource.doc.publicShare?.passwordHash || "";
      const valid =
        password.length > 0 && (await bcrypt.compare(password, hash));
      if (!valid) {
        return c.json({ success: false, error: "Incorrect password" }, 401);
      }

      const expiresAt = Date.now() + UNLOCK_TTL_MS;
      setCookie(
        c,
        unlockCookieName(token),
        `${expiresAt}.${signUnlock(token, expiresAt)}`,
        {
          httpOnly: true,
          sameSite: "Lax",
          secure: process.env.NODE_ENV === "production",
          path: "/api/share",
          maxAge: Math.floor(UNLOCK_TTL_MS / 1000),
        },
      );
      return c.json({ success: true, data: { unlocked: true } });
    } catch (error) {
      logger.error("Error unlocking share", { error });
      return c.json({ success: false, error: "Failed to unlock share" }, 500);
    }
  },
);

// GET /:token/content — shared app entry metadata (post-unlock)
app.openapi(
  createRoute({
    method: "get",
    path: "/{token}/content",
    tags: ["Public Shares"],
    summary: "Get sanitized share content",
    security: [],
    request: { params: TokenParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const token = c.req.param("token") as string;
      const resource = await findByToken(token);
      if (!resource) {
        return c.json({ success: false, error: "Share link not found" }, 404);
      }
      const gate = requireUnlock(c, token, resource);
      if (gate) return gate;

      // An app is a built bundle, not a definition the client renders: its
      // content is served as files from /api/share/:token/app/*, or, with
      // per-app origins on, from the app's own origin under a token this
      // share mints (`appUrl`).
      const appUrl = shareAppUrl(c, token, resource);
      const response = c.json(
        {
          success: true,
          data: {
            kind: "app" as const,
            title: resource.doc.title,
            published: Boolean(resource.doc.publishedSha),
            entry: `/api/share/${token}/app/`,
            ...(appUrl ? { appUrl } : {}),
          },
        },
        200,
        { "Cache-Control": "private, no-store" },
      );
      // The share page frames `appUrl` instead of navigating to /app/, so
      // the app's document never passes through this router: this call is
      // the view. It is made by the top-level share page, so the anonymous
      // id cookie sticks exactly as it did on the old document load.
      if (appUrl) {
        recordSharedAppOpen(
          c,
          response,
          resource.doc.workspaceId.toString(),
          resource.doc._id.toString(),
          { fetchDest: "document", contentType: "text/html" },
        );
      }
      return response;
    } catch (error) {
      logger.error("Error building share content", { error });
      return c.json({ success: false, error: "Failed to load content" }, 500);
    }
  },
);

// GET /:token/og-image — the link-preview picture (share-og.service)
app.use("/:token/og-image", serverTiming("share.ogImage"));
app.openapi(
  createRoute({
    method: "get",
    path: "/{token}/og-image",
    tags: ["Public Shares"],
    summary: "Link-preview image of an open share",
    description:
      "The app's own raster thumbnail (thumbnail.png/.jpg/.webp), as a JPEG at most 1200 px wide and ~300 KB (so WhatsApp shows the large card), for Open Graph crawlers. Only for a share anyone can open (enabled, no password); otherwise — or when the app has no raster thumbnail — 404, and the share page points crawlers at the generic /og-default.png instead. Cached publicly by blob oid.",
    security: [],
    request: { params: TokenParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const token = c.req.param("token") as string;
      const app = await timed("share.lookup", () => findShareByToken(token));
      const image = isOpenShare(app) ? await shareImageFor(app) : null;
      if (!image) {
        return c.json({ success: false, error: "No preview image" }, 404, {
          "Cache-Control": "no-store",
        });
      }
      return new Response(new Uint8Array(image.bytes), {
        status: 200,
        headers: {
          "Content-Type": image.contentType,
          "Content-Length": String(image.bytes.length),
          // Crawlers and their CDNs cache by URL; the URL carries the oid.
          // A day, not forever: unsharing must eventually stop serving it.
          "Cache-Control": "public, max-age=86400",
          ETag: image.etag,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      logger.error("Error serving share preview image", { error });
      return c.json({ success: false, error: "Failed to load image" }, 500);
    }
  },
);

// ── Anonymous viewer id (usage) ──
//
// A share link's viewers have no account, and an IP is neither one person
// (an office NAT) nor stable (a phone). So the first view of any shared app
// gets a random first-party id in a long-lived cookie, and usage stores only
// a prefixed hash of it (`anon:<hash>`, see anonIdFromCookie) — never the IP,
// never linked to one. `SameSite=None; Secure` so the same viewer is
// recognised when the app is framed on another site, where browsers that
// block third-party cookies simply leave it unrecognised.

const ANON_COOKIE = "mako_viewer";
const ANON_COOKIE_MAX_AGE_S = 400 * 24 * 60 * 60;
const ANON_COOKIE_VALUE = /^[A-Za-z0-9_-]{16,64}$/;

export function recordSharedAppOpen(
  c: Context,
  response: Response,
  workspaceId: string,
  appId: string,
  /**
   * What the open counts as, when the request is not the app document
   * itself (the share page's /content call, which frames the app from its
   * own origin). Default: read from the request and response.
   */
  servedAs?: { fetchDest: string; contentType: string },
): void {
  const fetchDest = servedAs?.fetchDest ?? c.req.header("sec-fetch-dest");
  const contentType =
    servedAs?.contentType ?? response.headers.get("content-type");
  if (!servedOpenSource(fetchDest, contentType, "share")) return;
  const userAgent = c.req.header("user-agent");
  const isBot = classifyUserAgent(userAgent) === "bot";
  const existing = getCookie(c, ANON_COOKIE);
  let cookie = existing && ANON_COOKIE_VALUE.test(existing) ? existing : null;
  let anonId = cookie ? anonIdFromCookie(cookie) : null;
  if (!cookie) {
    cookie = crypto.randomBytes(18).toString("base64url");
    // A top-level page keeps the cookie it is given, so this view is that
    // viewer's first. A frame may be refused it (third-party cookies), and
    // an id that never comes back would count one viewer per load — so a
    // frame's first view is recorded as not-yet-identifiable instead.
    if (fetchDest === "document") anonId = anonIdFromCookie(cookie);
    if (!isBot) {
      const secure = process.env.NODE_ENV === "production";
      response.headers.append(
        "Set-Cookie",
        [
          `${ANON_COOKIE}=${cookie}`,
          "Path=/api/share",
          `Max-Age=${ANON_COOKIE_MAX_AGE_S}`,
          "HttpOnly",
          secure ? "SameSite=None; Secure" : "SameSite=Lax",
        ].join("; "),
      );
    }
  }
  recordServedOpen({
    workspaceId,
    appId,
    userId: null,
    anonId,
    viewerKey: `anon:${cookie}`,
    fetchDest,
    contentType,
    pageSource: "share",
    userAgent,
    referer: c.req.header("referer"),
    host: c.req.header("host"),
  });
}

/**
 * Serve a shared Apps deployment's files (§13).
 *
 * Anonymous and token-gated, behind the same password unlock as every other
 * share route. Only ever reads the app's PUBLISHED deployment out of the
 * artifact store — no sandbox, no branch, no access to unpublished work.
 *
 * `__data/<name>.parquet` resolves to the app's materialized binding, so a
 * shared app keeps its data without the viewer touching a warehouse.
 */
async function serveSharedApp(c: Context): Promise<Response> {
  const token = c.req.param("token") as string;
  const grant = c.req.param("grant");
  const resource = await findByToken(token);
  if (!resource) {
    return shareAppJson({ success: false, error: "Share link not found" }, 404);
  }
  // `/u/<grant>/…` is authorized by the grant alone (the opaque-origin app
  // sends no cookie); `/app/…` by the unlock cookie, as before.
  if (grant !== undefined) {
    if (passwordRequired(resource) && !isValidUnlockGrant(token, grant)) {
      return shareAppJson(
        {
          success: false,
          error: "Password required",
          code: "PASSWORD_REQUIRED",
        },
        401,
      );
    }
  } else {
    const gate = requireUnlock(c, token, resource);
    if (gate) return withShareAppHeaders(gate);
  }

  const project = resource.doc;
  const sha = project.publishedSha;
  if (!sha) {
    return shareAppJson(
      { success: false, error: "This app has not been published yet" },
      404,
    );
  }
  const projectId = project._id.toString();
  const marker =
    grant !== undefined ? `/share/${token}/u/${grant}` : `/share/${token}/app`;
  const assetPath = (c.req.path.split(marker)[1] ?? "").replace(/^\/+/, "");

  const response = await serveDeploymentFile({
    projectId,
    sha,
    assetPath,
    private: true,
    // Anonymous: `__data/viewer.json` is null — there is nobody to describe.
    viewer: null,
    progress: wantsBindingProgress(c.req.header("accept")),
  });
  if (!response) {
    return shareAppJson({ success: false, error: "Not found" }, 404);
  }
  // The share page navigates straight here, so this page load IS the view.
  recordSharedAppOpen(c, response, project.workspaceId.toString(), projectId);

  // A cookie-authorized document of a password share: point the app's
  // relative requests at the grant, which they can carry and a cookie can't.
  const cookieGrant =
    grant === undefined && passwordRequired(resource)
      ? unlockGrantFor(c, token)
      : null;
  if (cookieGrant && isHtml(response)) {
    return await withShareBase(
      response,
      `/api/share/${encodeURIComponent(token)}/u/${cookieGrant}/`,
    );
  }
  return withShareAppHeaders(response);
}

/** The sandbox every shared app document gets (app-document-sandbox.ts). */
export const SHARE_APP_SANDBOX = APP_DOCUMENT_SANDBOX;

function isHtml(response: Response): boolean {
  return (response.headers.get("Content-Type") ?? "")
    .toLowerCase()
    .startsWith("text/html");
}

/**
 * Headers for anything the shared app's (opaque-origin) document fetches:
 * `Origin: null` + CORS-mode module scripts need a wildcard ACAO, which is
 * safe because nothing here is cookie-authorized for a cross-origin reader
 * (credentialed reads need an exact origin, which this never sends).
 */
function withShareAppHeaders(response: Response): Response {
  const headers = new Headers(response.headers);
  headers.set("Access-Control-Allow-Origin", "*");
  sandboxAppDocument(headers);
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers,
  });
}

function shareAppJson(body: object, status: number): Response {
  return withShareAppHeaders(
    new Response(JSON.stringify(body), {
      status,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "private, no-store",
      },
    }),
  );
}

/** Insert `<base href>` as the first thing in <head> (first base wins). */
async function withShareBase(
  response: Response,
  href: string,
): Promise<Response> {
  const html = await response.text();
  const tag = `<base href="${href.replace(/"/g, "&quot;")}">`;
  const head = /<head(\s[^>]*)?>/i.exec(html);
  const out = head
    ? html.slice(0, head.index + head[0].length) +
      tag +
      html.slice(head.index + head[0].length)
    : tag + html;
  const headers = new Headers(response.headers);
  headers.delete("Content-Length");
  // The page now embeds a credential: never let anything keep a copy.
  headers.set("Cache-Control", "private, no-store");
  return withShareAppHeaders(
    new Response(out, { status: response.status, headers }),
  );
}

app.get("/:token/app", serveSharedApp);
app.get("/:token/app/*", serveSharedApp);
app.get("/:token/u/:grant", serveSharedApp);
app.get("/:token/u/:grant/*", serveSharedApp);

/**
 * A shared app's `POST __data/<name>/refresh` — the SDK's `refresh()` from
 * an anonymous viewer. Runs the owner's published query under the owner's
 * connection, so it is what `allowLiveQueries` was defined to govern: off by
 * default (a share stays a frozen snapshot), and when the owner opts in,
 * throttled per binding with PUBLIC_REFRESH_COOLDOWN_MS — claimed
 * atomically, so a crowd of viewers is one warehouse query, not a crowd.
 */
async function refreshSharedBinding(c: Context): Promise<Response> {
  const token = c.req.param("token") as string;
  const grant = c.req.param("grant");
  const resource = await findByToken(token);
  if (!resource) {
    return shareAppJson({ success: false, error: "Share link not found" }, 404);
  }
  if (grant !== undefined) {
    if (passwordRequired(resource) && !isValidUnlockGrant(token, grant)) {
      return shareAppJson(
        {
          success: false,
          error: "Password required",
          code: "PASSWORD_REQUIRED",
        },
        401,
      );
    }
  } else {
    const gate = requireUnlock(c, token, resource);
    if (gate) return withShareAppHeaders(gate);
  }
  const project = resource.doc;
  if (!project.publishedSha) {
    return shareAppJson(
      { success: false, error: "This app has not been published yet" },
      404,
    );
  }
  return runSharedRefresh(
    c,
    project,
    c.req.param("name") as string,
    project.publishedSha,
  );
}

/**
 * The share's refresh policy, wherever the request arrives: off unless the
 * owner turned on `allowLiveQueries`, throttled per binding, run as nobody
 * under the owner's published query.
 */
async function runSharedRefresh(
  c: Context,
  project: IAppProject,
  name: string,
  at: string,
): Promise<Response> {
  if (!project.publicShare?.allowLiveQueries) {
    return shareAppJson(
      {
        success: false,
        error:
          "Refreshing data is not enabled for this link — the app's owner can turn it on in the share settings",
      },
      403,
    );
  }
  const input = {
    project,
    name,
    actorId: "",
    at,
    cooldownMs: PUBLIC_REFRESH_COOLDOWN_MS,
  };
  if (wantsBindingProgress(c.req.header("accept"))) {
    return withShareAppHeaders(
      await withQueryLabels({ mako_trigger: "public" }, async () =>
        refreshBindingProgress(input),
      ),
    );
  }
  try {
    const { status, body, headers } = await withQueryLabels(
      { mako_trigger: "public" },
      () => refreshBindingHttp(input),
    );
    return withShareAppHeaders(c.json(body, status, headers));
  } catch (error) {
    logger.error("Error refreshing a shared app's binding", { error });
    return shareAppJson({ success: false, error: "Failed to refresh" }, 500);
  }
}

/**
 * `POST __data/<name>/refresh` under a token a share minted (served by the
 * token route, on the app's own origin). The token alone proves the visitor
 * was let in; this re-checks that the share is STILL the app's enabled
 * share, so disabling or rotating it stops live queries at once, then
 * applies the share's policy, not a member's.
 */
export async function refreshForShareGrant(
  c: Context,
  grant: PreviewGrant,
  name: string,
): Promise<Response> {
  const project = await AppProject.findById(grant.projectId);
  const share = project?.publicShare;
  const current = share?.enabled && share.token ? share.token : null;
  if (
    !project ||
    !current ||
    !grant.share ||
    !sameString(shareFingerprint(current), grant.share) ||
    !grant.publishedSha
  ) {
    return shareAppJson({ success: false, error: "Share link not found" }, 404);
  }
  return runSharedRefresh(c, project, name, grant.publishedSha);
}

function sameString(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && crypto.timingSafeEqual(left, right);
}

// The opaque-origin app sends a bodiless POST (a simple request, no
// preflight) with no cookie: the grant path is how a password share's
// refresh is authorized.
app.post("/:token/app/__data/:name/refresh", refreshSharedBinding);
app.post("/:token/u/:grant/__data/:name/refresh", refreshSharedBinding);

export const publicShareRoutes = app;

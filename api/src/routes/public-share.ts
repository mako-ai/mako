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
 *   GET  /api/share/:token/artifacts/:artifactId — binding snapshot parquet
 *   GET  /api/share/:token/app/*      — the app's published deployment files
 */

import { withQueryLabels } from "../services/bigquery-labels";
import crypto from "node:crypto";
import bcrypt from "bcrypt";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { OPEN_RESPONSES, createRouter } from "../openapi/core";
import { type IAppProject } from "../database/workspace-schema";
import { loggers } from "../logging";
import { serverTiming, timed } from "../middleware/server-timing";
import { getArtifactStore } from "../services/artifact-store.service";
import { bindingArtifactKeyByName } from "../apps/bindings.service";
import { refreshBindingHttp } from "../apps/binding-refresh";
import { serveDeploymentFile } from "../apps/deployment.service";
import { serveParquetArtifact } from "../services/artifact-delivery.service";
import {
  anonIdFromCookie,
  classifyUserAgent,
  recordServedOpen,
  servedOpenSource,
} from "../apps/app-usage.service";
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
const ArtifactParam = TokenParam.extend({
  artifactId: z.string().openapi({ param: { name: "artifactId", in: "path" } }),
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
      // content is served as files from /api/share/:token/app/*.
      return c.json(
        {
          success: true,
          data: {
            kind: "app" as const,
            title: resource.doc.title,
            published: Boolean(resource.doc.publishedSha),
            entry: `/api/share/${token}/app/`,
          },
        },
        200,
        { "Cache-Control": "private, no-store" },
      );
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

// GET /:token/artifacts/:artifactId — stream snapshot parquet (post-unlock)
app.openapi(
  createRoute({
    method: "get",
    path: "/{token}/artifacts/{artifactId}",
    tags: ["Public Shares"],
    summary: "Stream a share snapshot artifact",
    security: [],
    request: { params: ArtifactParam },
    responses: {
      ...OPEN_RESPONSES,
      200: {
        description: "Parquet snapshot bytes.",
        content: {
          "application/vnd.apache.parquet": {
            schema: z.string().openapi({ format: "binary" }),
          },
        },
      },
    },
  }),
  async c => {
    try {
      const token = c.req.param("token") as string;
      const artifactId = c.req.param("artifactId");
      const resource = await findByToken(token);
      if (!resource) {
        return c.json({ success: false, error: "Share link not found" }, 404);
      }
      const gate = requireUnlock(c, token, resource);
      if (gate) return gate;

      const artifactKey = await bindingArtifactKeyByName(
        resource.doc,
        artifactId,
        "",
      );
      if (!artifactKey) {
        return c.json({ success: false, error: "Artifact not found" }, 404);
      }
      // App bindings have no revision to pin caching to, so nothing is lost
      // by handing the browser a signed bucket URL instead of a proxied
      // stream.
      const served = await serveParquetArtifact(
        getArtifactStore(),
        artifactKey,
        { cacheControl: "private, no-store" },
      );
      if (served) return served;
      return c.json({ success: false, error: "Artifact not found" }, 404);
    } catch (error) {
      logger.error("Error streaming share artifact", { error });
      return c.json({ success: false, error: "Failed to serve artifact" }, 500);
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
): void {
  const fetchDest = c.req.header("sec-fetch-dest");
  const contentType = response.headers.get("content-type");
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
  const resource = await findByToken(token);
  if (!resource) {
    return c.json({ success: false, error: "Share link not found" }, 404);
  }
  const gate = requireUnlock(c, token, resource);
  if (gate) return gate;

  const project = resource.doc;
  const sha = project.publishedSha;
  if (!sha) {
    return c.json(
      { success: false, error: "This app has not been published yet" },
      404,
    );
  }
  const projectId = project._id.toString();
  const assetPath = (c.req.path.split(`/share/${token}/app`)[1] ?? "").replace(
    /^\/+/,
    "",
  );

  const response = await serveDeploymentFile({
    projectId,
    sha,
    assetPath,
    private: true,
    // Anonymous: `__data/viewer.json` is null — there is nobody to describe.
    viewer: null,
  });
  if (response) {
    // The share page navigates straight here, so this page load IS the view.
    recordSharedAppOpen(c, response, project.workspaceId.toString(), projectId);
  }
  return response ?? c.json({ success: false, error: "Not found" }, 404);
}

app.get("/:token/app", serveSharedApp);
app.get("/:token/app/*", serveSharedApp);

/**
 * A shared app's `POST __data/<name>/refresh` — the SDK's `refresh()` from
 * an anonymous viewer. Runs the owner's published query under the owner's
 * connection, so it is what `allowLiveQueries` was defined to govern: off by
 * default (a share stays a frozen snapshot), and when the owner opts in,
 * throttled per binding with PUBLIC_REFRESH_COOLDOWN_MS — claimed
 * atomically, so a crowd of viewers is one warehouse query, not a crowd.
 */
app.post("/:token/app/__data/:name/refresh", async c => {
  const token = c.req.param("token") as string;
  const resource = await findByToken(token);
  if (!resource) {
    return c.json({ success: false, error: "Share link not found" }, 404);
  }
  const gate = requireUnlock(c, token, resource);
  if (gate) return gate;
  const project = resource.doc;
  if (!project.publishedSha) {
    return c.json(
      { success: false, error: "This app has not been published yet" },
      404,
    );
  }
  if (!project.publicShare?.allowLiveQueries) {
    return c.json(
      {
        success: false,
        error:
          "Refreshing data is not enabled for this link — the app's owner can turn it on in the share settings",
      },
      403,
    );
  }
  try {
    const { status, body, headers } = await withQueryLabels(
      { mako_trigger: "public" },
      () =>
        refreshBindingHttp({
          project,
          name: c.req.param("name"),
          actorId: "",
          at: project.publishedSha,
          cooldownMs: PUBLIC_REFRESH_COOLDOWN_MS,
        }),
    );
    return c.json(body, status, headers);
  } catch (error) {
    logger.error("Error refreshing a shared app's binding", { error });
    return c.json({ success: false, error: "Failed to refresh" }, 500);
  }
});

export const publicShareRoutes = app;

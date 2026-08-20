/**
 * Public share consumption routes — intentionally public (token-gated).
 *
 * Classification: Intentionally public. Access is gated by an unguessable
 * share token (and optionally a password). Anonymous viewers only ever see
 * materialized snapshot artifacts — no live query execution is reachable
 * from these routes.
 *
 *   GET  /api/share/:token            — share metadata (+passwordRequired)
 *   POST /api/share/:token/unlock     — verify password, set signed cookie
 *   GET  /api/share/:token/content    — sanitized dashboard/app definition
 *   GET  /api/share/:token/artifacts/:artifactId — stream snapshot parquet
 *   POST /api/share/:token/refresh    — throttled snapshot re-materialization
 */

import crypto from "node:crypto";
import { Readable } from "node:stream";
import bcrypt from "bcrypt";
import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import { OPEN_RESPONSES, createRouter } from "../openapi/core";
import {
  Dashboard,
  MakoApp,
  AppProjectV2,
  type IDashboard,
  type IMakoApp,
  type IAppProjectV2,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  buildAppSnapshot,
  type AppSnapshot,
} from "../services/app-version.service";
import { buildDataSourceMaterializationStatus } from "../services/dashboard-materialization.service";
import { queueDashboardArtifactRefresh } from "../services/dashboard-refresh-runner.service";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";
import {
  getBindingArtifactInfo,
  queueAppBindingMaterialization,
} from "../services/app-binding-materialization.service";
import { executePublicAppLiveBinding } from "../services/public-live-query.service";
import { bindingArtifactKey } from "../apps-v2/bindings.service";
import { serveDeploymentFile } from "../apps-v2/deployment.service";

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
/** Minimum delay between anonymous refresh triggers per dashboard. */
export const PUBLIC_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
/** Password attempts per token+IP within the window. */
const UNLOCK_MAX_ATTEMPTS = 10;
const UNLOCK_WINDOW_MS = 15 * 60 * 1000;

type SharedResource =
  | { type: "dashboard"; doc: IDashboard }
  | { type: "app"; doc: IMakoApp }
  | { type: "app-v2"; doc: IAppProjectV2 };

async function findByToken(token: string): Promise<SharedResource | null> {
  // Tokens are readable slugs (possibly short) or legacy random strings.
  if (!token || token.length < 3 || token.length > 128) return null;
  if (!/^[a-zA-Z0-9_-]+$/.test(token)) return null;
  const dashboard = await Dashboard.findOne({
    "publicShare.token": token,
    "publicShare.enabled": true,
  });
  if (dashboard) return { type: "dashboard", doc: dashboard };
  const makoApp = await MakoApp.findOne({
    "publicShare.token": token,
    "publicShare.enabled": true,
  });
  if (makoApp) return { type: "app", doc: makoApp };
  // Apps v2 shares the same publicShare primitive; what differs is what gets
  // served — a built deployment rather than a JSON definition (§13).
  const appV2 = await AppProjectV2.findOne({
    "publicShare.token": token,
    "publicShare.enabled": true,
  });
  if (appV2) return { type: "app-v2", doc: appV2 };
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

// ── Content sanitizers (never expose SQL, connection ids, or hashes) ──

async function buildDashboardContent(token: string, dashboard: IDashboard) {
  const workspaceId = dashboard.workspaceId.toString();
  const dashboardId = dashboard._id.toString();

  // Render the PUBLISHED definition (draft/published split) so a public viewer
  // never sees a half-edited or restored-but-unpublished draft. Fall back to
  // the live definition for dashboards that were never published (back-compat).
  const def = (dashboard.published as Record<string, any> | undefined) ?? {
    title: dashboard.title,
    description: dashboard.description,
    widgets: dashboard.widgets,
    globalFilters: dashboard.globalFilters,
    relationships: dashboard.relationships,
    crossFilter: dashboard.crossFilter,
    layout: dashboard.layout,
    dataSources: dashboard.dataSources,
  };

  // Materialization artifacts are server-owned and keyed by data-source id, so
  // compute status from the LIVE data source when present (freshest), falling
  // back to the published snapshot's definition.
  const liveDsById = new Map(
    (dashboard.dataSources || []).map(ds => [String(ds.id), ds]),
  );
  const dataSources = await Promise.all(
    ((def.dataSources as Array<Record<string, any>>) || []).map(async ds => {
      const liveDs = liveDsById.get(String(ds.id)) ?? ds;
      const materialization =
        (liveDs as { materialization?: string }).materialization === "live"
          ? "live"
          : "parquet";
      // Live data sources execute server-side per viewer; anonymous public
      // viewers never get live execution, so expose them as not-ready with no
      // artifact (mirrors the public app viewer refusing live bindings).
      if (materialization === "live") {
        return {
          id: ds.id,
          name: ds.name,
          tableRef: ds.tableRef,
          timeDimension: ds.timeDimension,
          computedColumns: ds.computedColumns,
          materialization,
          ready: false,
          rowCount: null,
          materializedAt: null,
          artifactUrl: null,
        };
      }
      const status = await buildDataSourceMaterializationStatus({
        workspaceId,
        dashboardId,
        dataSource: liveDs as any,
      });
      const ready = status.status === "ready" && !!status.artifactKey;
      return {
        id: ds.id,
        name: ds.name,
        tableRef: ds.tableRef,
        timeDimension: ds.timeDimension,
        computedColumns: ds.computedColumns,
        materialization,
        ready,
        rowCount: status.rowCount,
        materializedAt: status.builtAt || status.lastMaterializedAt,
        artifactUrl: ready
          ? `/api/share/${token}/artifacts/${encodeURIComponent(String(ds.id))}?rev=${encodeURIComponent(status.artifactRevision || "")}`
          : null,
      };
    }),
  );

  return {
    type: "dashboard" as const,
    title: def.title,
    description: def.description,
    widgets: def.widgets,
    globalFilters: def.globalFilters,
    relationships: def.relationships,
    crossFilter: def.crossFilter,
    layout: def.layout,
    dataSources,
    refresh: {
      cooldownMs: PUBLIC_REFRESH_COOLDOWN_MS,
      lastRefreshAt:
        dashboard.publicShare?.lastPublicRefreshAt?.toISOString() ?? null,
    },
  };
}

function buildAppContent(token: string, makoApp: IMakoApp) {
  // Render the PUBLISHED definition (draft/published split) so a public viewer
  // never sees half-edited or agent-in-progress work. Fall back to the live
  // draft for apps that were never published (back-compat).
  const def =
    (makoApp.published as AppSnapshot | undefined) ?? buildAppSnapshot(makoApp);
  // Materialization artifacts are server-owned and keyed by binding id, so we
  // hydrate artifact URLs from the LIVE binding caches (the published snapshot
  // intentionally excludes `cache`).
  const liveCacheById = new Map(
    (makoApp.dataBindings || []).map(b => [b.id, b.cache]),
  );
  // Owner opt-in: when enabled, the viewer may re-run live bindings via the
  // /binding/:id/execute route below (still owner-published SQL, never the
  // viewer's). Default off keeps existing shares snapshot-only.
  const allowLiveQueries = !!makoApp.publicShare?.allowLiveQueries;
  return {
    type: "app" as const,
    title: def.title,
    description: def.description,
    entrypoint: def.entrypoint,
    allowLiveQueries,
    files: (def.files || []).map(f => ({
      path: f.path,
      contents: f.contents,
    })),
    dependencies: def.dependencies || {},
    dataBindings: (def.dataBindings || []).map(b => {
      const cache = liveCacheById.get(b.id as string);
      const ready =
        b.materialization === "parquet" &&
        cache?.parquetBuildStatus === "ready" &&
        !!cache?.parquetArtifactKey;
      return {
        id: b.id,
        name: b.name,
        materialization: b.materialization ?? "live",
        ready,
        rowCount: cache?.rowCount ?? null,
        materializedAt: cache?.parquetBuiltAt ?? null,
        artifactUrl: ready
          ? `/api/share/${token}/artifacts/${encodeURIComponent(String(b.id))}?rev=${encodeURIComponent(cache?.artifactRevision || "")}`
          : null,
      };
    }),
  };
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
      const token = c.req.param("token");
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
      const token = c.req.param("token");
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

// GET /:token/content — sanitized definition (post-unlock)
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
      const token = c.req.param("token");
      const resource = await findByToken(token);
      if (!resource) {
        return c.json({ success: false, error: "Share link not found" }, 404);
      }
      const gate = requireUnlock(c, token, resource);
      if (gate) return gate;

      if (resource.type === "app-v2") {
        // A v2 app is a built bundle, not a definition the client renders:
        // its content is served as files from /api/share/:token/app/*.
        return c.json(
          {
            success: true,
            data: {
              kind: "app-v2" as const,
              title: resource.doc.title,
              published: Boolean(resource.doc.publishedSha),
              entry: `/api/share/${token}/app/`,
            },
          },
          200,
          { "Cache-Control": "private, no-store" },
        );
      }
      const data =
        resource.type === "dashboard"
          ? await buildDashboardContent(token, resource.doc)
          : buildAppContent(token, resource.doc);

      return c.json({ success: true, data }, 200, {
        "Cache-Control": "private, no-store",
      });
    } catch (error) {
      logger.error("Error building share content", { error });
      return c.json({ success: false, error: "Failed to load content" }, 500);
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
    request: {
      params: ArtifactParam,
      query: z.object({ rev: z.string().optional() }),
    },
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
      const token = c.req.param("token");
      const artifactId = c.req.param("artifactId");
      const resource = await findByToken(token);
      if (!resource) {
        return c.json({ success: false, error: "Share link not found" }, 404);
      }
      const gate = requireUnlock(c, token, resource);
      if (gate) return gate;

      let artifactKey: string | null = null;
      let revision: string | null = null;
      let rowCount: number | null = null;

      if (resource.type === "dashboard") {
        const dataSource = resource.doc.dataSources?.find(
          ds => ds.id === artifactId,
        );
        if (!dataSource) {
          return c.json({ success: false, error: "Artifact not found" }, 404);
        }
        const status = await buildDataSourceMaterializationStatus({
          workspaceId: resource.doc.workspaceId.toString(),
          dashboardId: resource.doc._id.toString(),
          dataSource,
        });
        artifactKey = status.artifactKey;
        revision = status.artifactRevision;
        rowCount = status.rowCount;
      } else if (resource.type === "app-v2") {
        artifactKey = bindingArtifactKey(
          resource.doc._id.toString(),
          artifactId,
        );
      } else {
        const info = getBindingArtifactInfo(resource.doc, artifactId);
        if (info) {
          artifactKey = info.artifactKey;
          revision = info.revision ?? null;
          rowCount = info.rowCount ?? null;
        }
      }

      if (!artifactKey) {
        return c.json({ success: false, error: "Artifact not found" }, 404);
      }

      const store = getDashboardArtifactStore();
      const stream = await store.openReadStream(artifactKey);
      if (!stream) {
        return c.json({ success: false, error: "Artifact not found" }, 404);
      }

      const rev = c.req.query("rev");
      const cacheControl =
        rev && revision && rev === revision
          ? "private, max-age=86400, immutable"
          : "private, no-store";

      return c.body(Readable.toWeb(stream as Readable) as ReadableStream, 200, {
        "Content-Type": "application/vnd.apache.parquet",
        "X-Row-Count": String(rowCount ?? 0),
        "Cache-Control": cacheControl,
      });
    } catch (error) {
      logger.error("Error streaming share artifact", { error });
      return c.json({ success: false, error: "Failed to serve artifact" }, 500);
    }
  },
);

// POST /:token/binding/:bindingId/execute — run a published live binding.
// Apps only, and only when the owner enabled `publicShare.allowLiveQueries`.
// The SQL is always the owner's PUBLISHED binding code (never viewer-supplied),
// executed read-only + row-capped + rate-limited under the owner's connection.
app.openapi(
  createRoute({
    method: "post",
    path: "/{token}/binding/{bindingId}/execute",
    tags: ["Public Shares"],
    summary: "Run a shared app's published live binding",
    security: [],
    request: {
      params: TokenParam.extend({
        bindingId: z.string().openapi({
          param: { name: "bindingId", in: "path" },
        }),
      }),
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const token = c.req.param("token");
      const bindingId = c.req.param("bindingId");
      const resource = await findByToken(token);
      if (!resource) {
        return c.json({ success: false, error: "Share link not found" }, 404);
      }
      if (resource.type !== "app") {
        return c.json(
          { success: false, error: "Live queries are only supported for apps" },
          400,
        );
      }
      const gate = requireUnlock(c, token, resource);
      if (gate) return gate;

      const result = await executePublicAppLiveBinding({
        app: resource.doc,
        bindingId,
        token,
      });
      if (!result.success) {
        return c.json(
          { success: false, error: result.error },
          result.status as 400,
        );
      }
      return c.json(
        {
          success: true,
          rows: result.rows,
          fields: result.fields,
          rowCount: result.rowCount,
        },
        200,
        { "Cache-Control": "private, no-store" },
      );
    } catch (error) {
      logger.error("Error running public live binding", { error });
      return c.json({ success: false, error: "Failed to run query" }, 500);
    }
  },
);

// POST /:token/refresh — throttled snapshot refresh.
// Only re-runs the owner-defined data source queries; anonymous viewers can
// never execute arbitrary queries.
app.openapi(
  createRoute({
    method: "post",
    path: "/{token}/refresh",
    tags: ["Public Shares"],
    summary: "Refresh a public share snapshot",
    security: [],
    request: { params: TokenParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const token = c.req.param("token");
      const resource = await findByToken(token);
      if (!resource) {
        return c.json({ success: false, error: "Share link not found" }, 404);
      }
      const gate = requireUnlock(c, token, resource);
      if (gate) return gate;
      if (resource.type === "app") {
        const appDoc = resource.doc;
        if (
          !appDoc.dataBindings.some(
            binding => binding.materialization === "parquet",
          )
        ) {
          return c.json(
            {
              success: false,
              error: "No materialized app data sources to refresh",
            },
            400,
          );
        }
      } else if (resource.type === "dashboard") {
        const dashboardDoc = resource.doc;
        if (
          !(dashboardDoc.dataSources || []).some(
            ds => ds.materialization !== "live",
          )
        ) {
          return c.json(
            {
              success: false,
              error: "No materialized dashboard data sources to refresh",
            },
            400,
          );
        }
      }

      const last =
        resource.doc.publicShare?.lastPublicRefreshAt?.getTime() ?? 0;
      const elapsed = Date.now() - last;
      if (elapsed < PUBLIC_REFRESH_COOLDOWN_MS) {
        const retryAfterMs = PUBLIC_REFRESH_COOLDOWN_MS - elapsed;
        return c.json(
          {
            success: false,
            error: "Refresh is cooling down",
            code: "REFRESH_COOLDOWN",
            retryAfterMs,
          },
          429,
        );
      }

      // Claim the cooldown slot atomically so concurrent anonymous viewers
      // can't queue duplicate refreshes.
      const claimed =
        resource.type === "dashboard"
          ? await Dashboard.findOneAndUpdate(
              {
                _id: resource.doc._id,
                "publicShare.enabled": true,
                $or: [
                  { "publicShare.lastPublicRefreshAt": { $exists: false } },
                  {
                    "publicShare.lastPublicRefreshAt": {
                      $lte: new Date(Date.now() - PUBLIC_REFRESH_COOLDOWN_MS),
                    },
                  },
                ],
              },
              { $set: { "publicShare.lastPublicRefreshAt": new Date() } },
              { new: true },
            )
          : await MakoApp.findOneAndUpdate(
              {
                _id: resource.doc._id,
                "publicShare.enabled": true,
                $or: [
                  { "publicShare.lastPublicRefreshAt": { $exists: false } },
                  {
                    "publicShare.lastPublicRefreshAt": {
                      $lte: new Date(Date.now() - PUBLIC_REFRESH_COOLDOWN_MS),
                    },
                  },
                ],
              },
              { $set: { "publicShare.lastPublicRefreshAt": new Date() } },
              { new: true },
            );
      if (!claimed) {
        return c.json(
          {
            success: false,
            error: "Refresh is cooling down",
            code: "REFRESH_COOLDOWN",
            retryAfterMs: PUBLIC_REFRESH_COOLDOWN_MS,
          },
          429,
        );
      }

      let queued = false;
      let alreadyRunning = false;
      let dataSourceIds: string[] = [];

      if (resource.type === "dashboard") {
        const dashboard = resource.doc;
        // force: true re-queries the owner-defined source queries even when the
        // dashboard definition is unchanged. Without it, the rebuild service
        // reuses the cached parquet (no new parquetBuiltAt), so the viewer's
        // "data changed?" poll never observes a fresh snapshot and times out.
        // The 5-minute cooldown above guards against abusive/expensive re-runs.
        const queueResult = await queueDashboardArtifactRefresh({
          dashboardId: dashboard._id.toString(),
          workspaceId: dashboard.workspaceId.toString(),
          force: true,
          triggerType: "manual",
        });
        queued = queueResult.queued;
        alreadyRunning = !queueResult.queued;
        dataSourceIds = queueResult.dataSourceIds;
      } else if (resource.type === "app-v2") {
        // §13.4.2: scheduled/anonymous refresh of v2 bindings is not built.
        return c.json(
          {
            success: false,
            error: "Refresh is not available for this app yet",
          },
          501,
        );
      } else {
        const appDoc = resource.doc;
        const materializedBindings = appDoc.dataBindings.filter(
          binding => binding.materialization === "parquet",
        );
        const results = await Promise.all(
          materializedBindings.map(binding =>
            queueAppBindingMaterialization({
              workspaceId: appDoc.workspaceId.toString(),
              appId: appDoc._id.toString(),
              bindingId: binding.id,
              force: true,
            }),
          ),
        );
        queued = results.some(result => result.queued);
        alreadyRunning = results.some(result => result.alreadyRunning);
        dataSourceIds = results.map(result => result.bindingId);
      }

      return c.json({
        success: true,
        queued,
        alreadyRunning,
        dataSourceIds,
        cooldownMs: PUBLIC_REFRESH_COOLDOWN_MS,
      });
    } catch (error) {
      logger.error("Error refreshing public share", { error });
      return c.json({ success: false, error: "Failed to refresh" }, 500);
    }
  },
);

/**
 * Serve a shared Apps v2 deployment's files (§13).
 *
 * Anonymous and token-gated, behind the same password unlock as every other
 * share route. Only ever reads the app's PUBLISHED deployment out of the
 * artifact store — no sandbox, no branch, no access to unpublished work.
 *
 * `__data/<name>.parquet` resolves to the app's materialized binding, so a
 * shared app keeps its data without the viewer touching a warehouse.
 */
async function serveSharedAppV2(c: Context): Promise<Response> {
  const token = c.req.param("token");
  const resource = await findByToken(token);
  if (!resource || resource.type !== "app-v2") {
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
  });
  return response ?? c.json({ success: false, error: "Not found" }, 404);
}

app.get("/:token/app", serveSharedAppV2);
app.get("/:token/app/*", serveSharedAppV2);

export const publicShareRoutes = app;

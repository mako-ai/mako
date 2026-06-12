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
 *   POST /api/share/:token/refresh    — throttled re-materialization (dash)
 */

import crypto from "node:crypto";
import { Readable } from "node:stream";
import bcrypt from "bcrypt";
import { Hono, type Context } from "hono";
import { getCookie, setCookie } from "hono/cookie";
import {
  Dashboard,
  MakoApp,
  type IDashboard,
  type IMakoApp,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import { buildDataSourceMaterializationStatus } from "../services/dashboard-materialization.service";
import { queueDashboardArtifactRefresh } from "../services/dashboard-refresh-runner.service";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";
import { getBindingArtifactInfo } from "../services/app-binding-materialization.service";

const logger = loggers.api("public-share");

const app = new Hono();

/** How long an unlock cookie stays valid. */
const UNLOCK_TTL_MS = 12 * 60 * 60 * 1000;
/** Minimum delay between anonymous refresh triggers per dashboard. */
export const PUBLIC_REFRESH_COOLDOWN_MS = 5 * 60 * 1000;
/** Password attempts per token+IP within the window. */
const UNLOCK_MAX_ATTEMPTS = 10;
const UNLOCK_WINDOW_MS = 15 * 60 * 1000;

type SharedResource =
  | { type: "dashboard"; doc: IDashboard }
  | { type: "app"; doc: IMakoApp };

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

  const dataSources = await Promise.all(
    (dashboard.dataSources || []).map(async ds => {
      const status = await buildDataSourceMaterializationStatus({
        workspaceId,
        dashboardId,
        dataSource: ds,
      });
      const ready = status.status === "ready" && !!status.artifactKey;
      return {
        id: ds.id,
        name: ds.name,
        tableRef: ds.tableRef,
        timeDimension: ds.timeDimension,
        computedColumns: ds.computedColumns,
        ready,
        rowCount: status.rowCount,
        materializedAt: status.builtAt || status.lastMaterializedAt,
        artifactUrl: ready
          ? `/api/share/${token}/artifacts/${encodeURIComponent(ds.id)}?rev=${encodeURIComponent(status.artifactRevision || "")}`
          : null,
      };
    }),
  );

  return {
    type: "dashboard" as const,
    title: dashboard.title,
    description: dashboard.description,
    widgets: dashboard.widgets,
    globalFilters: dashboard.globalFilters,
    relationships: dashboard.relationships,
    crossFilter: dashboard.crossFilter,
    layout: dashboard.layout,
    dataSources,
    refresh: {
      cooldownMs: PUBLIC_REFRESH_COOLDOWN_MS,
      lastRefreshAt:
        dashboard.publicShare?.lastPublicRefreshAt?.toISOString() ?? null,
    },
  };
}

function buildAppContent(token: string, makoApp: IMakoApp) {
  return {
    type: "app" as const,
    title: makoApp.title,
    description: makoApp.description,
    entrypoint: makoApp.entrypoint,
    files: (makoApp.files || []).map(f => ({
      path: f.path,
      contents: f.contents,
    })),
    dependencies: makoApp.dependencies || {},
    dataBindings: (makoApp.dataBindings || []).map(b => {
      const ready =
        b.materialization === "parquet" &&
        b.cache?.parquetBuildStatus === "ready" &&
        !!b.cache?.parquetArtifactKey;
      return {
        id: b.id,
        name: b.name,
        materialization: b.materialization ?? "live",
        ready,
        rowCount: b.cache?.rowCount ?? null,
        materializedAt: b.cache?.parquetBuiltAt ?? null,
        artifactUrl: ready
          ? `/api/share/${token}/artifacts/${encodeURIComponent(b.id)}?rev=${encodeURIComponent(b.cache?.artifactRevision || "")}`
          : null,
      };
    }),
  };
}

// ── Routes ──

// GET /:token — public metadata (safe before password unlock)
app.get("/:token", async c => {
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
});

// POST /:token/unlock — verify password, set signed HttpOnly cookie
app.post("/:token/unlock", async c => {
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
    const valid = password.length > 0 && (await bcrypt.compare(password, hash));
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
});

// GET /:token/content — sanitized definition (post-unlock)
app.get("/:token/content", async c => {
  try {
    const token = c.req.param("token");
    const resource = await findByToken(token);
    if (!resource) {
      return c.json({ success: false, error: "Share link not found" }, 404);
    }
    const gate = requireUnlock(c, token, resource);
    if (gate) return gate;

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
});

// GET /:token/artifacts/:artifactId — stream snapshot parquet (post-unlock)
app.get("/:token/artifacts/:artifactId", async c => {
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

    return new Response(Readable.toWeb(stream as Readable) as ReadableStream, {
      headers: {
        "Content-Type": "application/vnd.apache.parquet",
        "X-Row-Count": String(rowCount ?? 0),
        "Cache-Control": cacheControl,
      },
    });
  } catch (error) {
    logger.error("Error streaming share artifact", { error });
    return c.json({ success: false, error: "Failed to serve artifact" }, 500);
  }
});

// POST /:token/refresh — throttled snapshot refresh (dashboards only).
// Only re-runs the owner-defined data source queries; anonymous viewers can
// never execute arbitrary queries.
app.post("/:token/refresh", async c => {
  try {
    const token = c.req.param("token");
    const resource = await findByToken(token);
    if (!resource) {
      return c.json({ success: false, error: "Share link not found" }, 404);
    }
    const gate = requireUnlock(c, token, resource);
    if (gate) return gate;
    if (resource.type !== "dashboard") {
      return c.json(
        { success: false, error: "Refresh is only available for dashboards" },
        400,
      );
    }

    const dashboard = resource.doc;
    const last = dashboard.publicShare?.lastPublicRefreshAt?.getTime() ?? 0;
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
    const claimed = await Dashboard.findOneAndUpdate(
      {
        _id: dashboard._id,
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

    const queueResult = await queueDashboardArtifactRefresh({
      dashboardId: dashboard._id.toString(),
      workspaceId: dashboard.workspaceId.toString(),
      triggerType: "manual",
    });

    return c.json({
      success: true,
      queued: queueResult.queued,
      alreadyRunning: !queueResult.queued,
      cooldownMs: PUBLIC_REFRESH_COOLDOWN_MS,
    });
  } catch (error) {
    logger.error("Error refreshing public share", { error });
    return c.json({ success: false, error: "Failed to refresh" }, 500);
  }
});

export const publicShareRoutes = app;

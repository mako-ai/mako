/**
 * The Apps home: usage, recently opened, discovery, the archive, the feed
 * and search. Static paths: mounted before the `/{id}` routes.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import {
  APP_USAGE_PLACEMENT_SHELVES,
  AppProject,
} from "../../database/workspace-schema";
import {
  findAppInSnapshot,
  loadAppsIndex,
  resolveAppRef,
} from "../../apps/app-index.service";
import {
  acceptUsageBeat,
  classifyUserAgent,
  getRecentlyViewedApps,
  recordAppUsage,
} from "../../apps/app-usage.service";
import {
  homeUsageStats,
  listHomeDiscoveryApps,
  visibleHomeAppIds,
} from "../../apps/app-home-base.service";
import { searchDiscoveryApps } from "../../apps/app-discovery.service";
import {
  appUsageScores,
  prefetchQueryEmbedding,
  relatedSignals,
} from "../../apps/app-search.service";
import { FeedCursorError, getFeedPage } from "../../apps/app-feed.service";
import {
  ArchiveRestoreError,
  archivedThumbnail,
  listArchivedApps,
  restoreArchivedApp,
} from "../../apps/app-archive.service";
import { readThumbnailBlob, thumbnailResponse } from "../../apps/app-thumbnail";
import { boundRepoDirIfExists } from "../../apps/workspace-repo-required";
import { canSeeIndexedApp } from "../../apps/app-authorization";
import { RepoRequiredError } from "../../apps/config";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { timed } from "../../middleware/server-timing";
import {
  ProjectParam,
  WorkspaceParam,
  actingUserId,
  handleError,
  memberRoleFor,
} from "./shared";

export const appsHomeRoutes = createRouter();

// ---------------------------------------------------------------------------
// Usage — who opens which app (app-usage.service). The two reads are
// registered before /{id} so "usage" and "recent" are never read as app refs.
// Both report only apps the caller can see in the list.
// ---------------------------------------------------------------------------

appsHomeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/usage",
    tags: ["Apps"],
    summary: "Usage and popularity of the apps the caller can see",
    description:
      "Per app, over the last `days` UTC days (default 28): distinct viewers, viewers who are not the app's authors, their viewer-days, opens, active seconds, last open (anyone / non-author) and a popularity score — the sum over non-author viewers of distinct active days, each weighted 0.5^(age_days/14). Every visible app is listed, zeros when unviewed.",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: z.object({
        days: z.coerce.number().int().min(1).max(400).optional(),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { days } = c.req.valid("query");
      const userId = actingUserId(c);
      const role =
        (c.get("memberRole") as string | undefined) ??
        (await memberRoleFor(workspaceId, userId));
      const [stats, visible] = await Promise.all([
        timed("usage.stats", () => homeUsageStats(workspaceId, { days })),
        timed("usage.visible", () =>
          visibleHomeAppIds(workspaceId, userId, role),
        ),
      ]);
      const apps = [...stats.values()].filter(s => visible.has(s.appId));
      return c.json({ success: true as const, apps }, 200);
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json({ success: true as const, apps: [] }, 200);
      }
      return handleError(c, error);
    }
  },
);

appsHomeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/recent",
    tags: ["Apps"],
    summary: "Apps the caller opened most recently",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: z.object({
        limit: z.coerce.number().int().min(1).max(100).optional(),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const limit = c.req.valid("query").limit ?? 20;
      const userId = actingUserId(c);
      if (!userId) return c.json({ success: true as const, apps: [] }, 200);
      const role =
        (c.get("memberRole") as string | undefined) ??
        (await memberRoleFor(workspaceId, userId));
      // Over-fetch: an app may have been deleted or made private since.
      const [recent, visible] = await Promise.all([
        getRecentlyViewedApps(workspaceId, userId, {
          limit: Math.min(100, limit + 20),
        }),
        visibleHomeAppIds(workspaceId, userId, role),
      ]);
      const apps = recent.filter(r => visible.has(r.appId)).slice(0, limit);
      return c.json({ success: true as const, apps }, 200);
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json({ success: true as const, apps: [] }, 200);
      }
      return handleError(c, error);
    }
  },
);

appsHomeRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/usage",
    tags: ["Apps"],
    summary: "Report a view of the published app",
    description:
      "Sent by Mako's own app views: `open` once per view, `heartbeat` every 60 s while the page is visible (each worth 60 active seconds), both carrying the view's `sessionId`. Every accepted report lands in the raw event log; a repeat open inside the throttle window is logged flagged `throttled` and left out of the daily counters, a heartbeat flood is refused (429). API keys without a user are not viewers and are ignored. Answers 204.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        content: {
          "application/json": {
            schema: z.object({
              kind: z.enum(["open", "heartbeat"]),
              source: z.enum(["app", "share", "embed"]).default("app"),
              /** Generated by the client per view; heartbeats repeat it. */
              sessionId: z.string().min(1).max(64).optional(),
              referrerKind: z
                .enum(["internal", "external", "direct"])
                .optional(),
              /** The Apps home card it was opened from (opens only). */
              placement: z
                .object({
                  surface: z.literal("home"),
                  shelf: z.enum(APP_USAGE_PLACEMENT_SHELVES),
                  position: z.number().int().min(0).max(10_000),
                })
                .optional(),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId, id } = c.req.valid("param");
      const { kind, source, sessionId, referrerKind, placement } =
        c.req.valid("json");
      const userId = actingUserId(c);
      if (!userId) return c.body(null, 204);
      const accepted = acceptUsageBeat(`${workspaceId}:${userId}:${id}`, kind);
      if (!accepted && kind === "heartbeat") {
        return c.json({ success: false, error: "Too many usage reports" }, 429);
      }
      // The index without a mirror fetch: a heartbeat a minute must not
      // pull from GitHub. A miss (an app pushed seconds ago to another
      // instance) falls back to the fetching resolve.
      const app =
        findAppInSnapshot(
          await loadAppsIndex(workspaceId, { freshen: false }),
          id,
        ) ?? (await resolveAppRef(workspaceId, id));
      if (!app) {
        return c.json({ success: false, error: "App not found" }, 404);
      }
      const state = await AppProject.findOne({
        _id: new Types.ObjectId(app.appId),
        workspaceId: new Types.ObjectId(workspaceId),
      })
        .select("access workspaceRole sharedWith owner_id createdBy")
        .lean();
      const role =
        (c.get("memberRole") as string | undefined) ??
        (await memberRoleFor(workspaceId, userId));
      if (!canSeeIndexedApp(app, state, userId, role)) {
        return c.json({ success: false, error: "App not found" }, 404);
      }
      await recordAppUsage({
        workspaceId,
        appId: app.appId,
        userId,
        kind,
        source,
        sessionId: sessionId ?? null,
        referrerKind: referrerKind ?? null,
        uaClass: classifyUserAgent(c.req.header("user-agent")),
        throttled: !accepted,
        placement: placement ?? null,
      });
      return c.body(null, 204);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

// ---------------------------------------------------------------------------
// Discovery — the Apps home and its search. Static paths, registered before
// /{id} so the param route can't shadow them.
// ---------------------------------------------------------------------------

appsHomeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/discovery",
    tags: ["Apps"],
    summary: "Apps home: every visible app with its discovery facts",
    description:
      "Owner, creation date, deployment, thumbnail, data freshness and health (failed deploy, failed binding refreshes) for every app the caller can see — the same visibility as the list. Popularity is the usage API's, joined on the id by the client.",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const userId = actingUserId(c);
      const role =
        (c.get("memberRole") as string | undefined) ??
        (await memberRoleFor(workspaceId, userId));
      const apps = await listHomeDiscoveryApps(workspaceId, userId, role);
      return c.json({ success: true as const, apps }, 200);
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json({ success: true as const, apps: [] }, 200);
      }
      return handleError(c, error);
    }
  },
);

appsHomeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/archived",
    tags: ["Apps"],
    summary: "Archived apps the caller may see",
    description:
      "Apps under the repo's `archive/` tree (moved there by the lifecycle job), read from main: title, description and thumbnail from each mako.json, the original path Restore moves it back to, and when and by whom it was archived (the commit that added it). Same visibility as the list: workspace apps for members, a personal app only for its mapped owner. Newest archive first.",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const userId = actingUserId(c);
      const role = await memberRoleFor(workspaceId, userId);
      const apps = await listArchivedApps(workspaceId, userId, role);
      return c.json({ success: true as const, apps }, 200);
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json({ success: true as const, apps: [] }, 200);
      }
      return handleError(c, error);
    }
  },
);

appsHomeRoutes.openapi(
  createRoute({
    method: "post",
    path: "/archived/restore",
    tags: ["Apps"],
    summary: "Restore an archived app to where it was",
    description:
      "Moves `archive/<...>` back to its original folder as one commit on main; the app keeps its id. The Workspace tree needs an editing role, a personal tree is its owner's alone (403). 404 when the archived app is not there or not visible; 409 when its original address is taken. The app gets a fresh lifecycle grace period, so it is not archived again straight away.",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({ path: z.string().min(1).max(1024) }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { path } = c.req.valid("json");
      const userId = actingUserId(c);
      const role = await memberRoleFor(workspaceId, userId);
      const restored = await restoreArchivedApp(
        workspaceId,
        path,
        userId,
        role,
      );
      return c.json({ success: true as const, ...restored }, 200);
    } catch (error) {
      if (error instanceof ArchiveRestoreError) {
        return c.json(
          { success: false as const, error: error.message },
          error.status,
        );
      }
      return handleError(c, error);
    }
  },
);

appsHomeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/archived/thumbnail",
    tags: ["Apps"],
    summary: "An archived app's thumbnail image",
    description:
      "The thumbnail an archived app ships, for its card on the Apps home's Archived chip; `v` is the blob oid (cache version). 404 when it ships none or the caller may not see it.",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: z.object({
        path: z
          .string()
          .min(1)
          .max(1024)
          .openapi({ param: { name: "path", in: "query" } }),
        v: z
          .string()
          .max(64)
          .optional()
          .openapi({ param: { name: "v", in: "query" } }),
        w: z
          .string()
          .max(8)
          .optional()
          .openapi({ param: { name: "w", in: "query" } }),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { path, v, w } = c.req.valid("query");
      const userId = actingUserId(c);
      const role = await memberRoleFor(workspaceId, userId);
      const thumbnail = await archivedThumbnail(
        workspaceId,
        path,
        userId,
        role,
      );
      const res = thumbnail
        ? await thumbnailResponse({
            thumbnail,
            v,
            w,
            ifNoneMatch: c.req.header("if-none-match"),
            read: async () => {
              const repoDir = await boundRepoDirIfExists(workspaceId);
              return repoDir ? readThumbnailBlob(repoDir, thumbnail) : null;
            },
          })
        : null;
      if (!res) {
        return c.json(
          { success: false, error: "This app has no thumbnail" },
          404,
        );
      }
      return res;
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsHomeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/feed",
    tags: ["Apps"],
    summary: "Apps home feed: shelves, then every other app ranked, paged",
    description:
      "Without `cursor`: the Popular and New shelves (`popular`, `fresh`) and the first page of the Recommended grid (`apps`), every visible app appearing exactly once across the three. The Recommended order is ranked server-side (popularity, recency, the caller's own reads, co-usage, quality, a per-viewer-per-day exploration jitter) and frozen for 24 h; pass `nextCursor` back for the next page until it is null. Same card shape and visibility as /discovery; visibility is re-checked on every page. 410 when the cursor's snapshot expired (reload the feed).",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: z.object({
        cursor: z
          .string()
          .max(512)
          .optional()
          .openapi({ param: { name: "cursor", in: "query" } }),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(60)
          .optional()
          .openapi({ param: { name: "limit", in: "query" } }),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { cursor, limit } = c.req.valid("query");
      const userId = actingUserId(c);
      const role =
        (c.get("memberRole") as string | undefined) ??
        (await memberRoleFor(workspaceId, userId));
      const page = await getFeedPage(workspaceId, userId, role, {
        cursor: cursor || null,
        limit,
      });
      return c.json({ success: true as const, ...page }, 200);
    } catch (error) {
      if (error instanceof FeedCursorError) {
        return c.json(
          { success: false as const, error: error.message },
          error.status,
        );
      }
      if (error instanceof RepoRequiredError) {
        return c.json(
          {
            success: true as const,
            popular: [],
            fresh: [],
            apps: [],
            offset: 0,
            nextCursor: null,
            total: 0,
            recommendedTotal: 0,
          },
          200,
        );
      }
      return handleError(c, error);
    }
  },
);

appsHomeRoutes.openapi(
  createRoute({
    method: "get",
    path: "/search",
    tags: ["Apps"],
    summary: "Search apps",
    description:
      'Free-text search over each visible app\'s title, description, path, owner and the warehouse tables its bindings read (FROM/JOIN identifiers in bindings/*.sql, indexed per push). Word matches come first, ranked best first, with the fields that matched. Then, when embeddings are available, up to 12 apps those fields missed, closest in meaning first, with `matches: ["related"]`: apps whose search document (title, description, README, UI labels) is semantically close to the query, or contains its words.',
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam,
      query: z.object({
        q: z
          .string()
          .max(200)
          .openapi({ param: { name: "q", in: "query" } }),
        limit: z.coerce
          .number()
          .int()
          .min(1)
          .max(100)
          .optional()
          .openapi({ param: { name: "limit", in: "query" } }),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId } = c.req.valid("param");
      const { q, limit } = c.req.valid("query");
      const userId = actingUserId(c);
      const role =
        (c.get("memberRole") as string | undefined) ??
        (await memberRoleFor(workspaceId, userId));
      prefetchQueryEmbedding(q);
      const [visible, usage] = await Promise.all([
        listHomeDiscoveryApps(workspaceId, userId, role),
        appUsageScores(workspaceId),
      ]);
      const related = await relatedSignals(
        workspaceId,
        q,
        visible.map(a => a.id),
      );
      const apps = searchDiscoveryApps(visible, q, {
        limit: limit ?? 50,
        usage,
        related,
      });
      return c.json({ success: true as const, apps }, 200);
    } catch (error) {
      if (error instanceof RepoRequiredError) {
        return c.json({ success: true as const, apps: [] }, 200);
      }
      return handleError(c, error);
    }
  },
);

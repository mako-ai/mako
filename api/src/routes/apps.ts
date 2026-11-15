/**
 * Apps routes — git-backed apps (see apps.md).
 *
 * Classification: Authenticated + workspace-scoped
 * (`unifiedAuthMiddleware` + workspace verification).
 *
 * Runs in PARALLEL with the v1 `/apps` routes. The durable store is the
 * workspace's linked GitHub repo (see /link, repo-binding.service); apps are
 * subdirectories in it, worked on inside E2B sandboxes. Always available (no
 * feature flag).
 *
 * This module owns the middleware chain and mounts the per-concern
 * sub-routers in `routes/apps/`.
 */
import type { Context } from "hono";
import { getCookie } from "hono/cookie";
import {
  anonymousViewerRedirect,
  isPreviewCrawler,
  liveViewerRedirect,
} from "../apps/live-viewer-redirect";
import { sessionManager } from "../auth/session";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { enrichContextWithWorkspace } from "../logging";
import {
  concurrencyLimit,
  repoWorkPool,
} from "../middleware/concurrency-limit";
import { serverTiming, timed } from "../middleware/server-timing";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { createRouter } from "../openapi/core";
import { ensureAutoJoin } from "../services/auto-join.service";
import { crawlerPreviewPage, publicOrigin } from "../services/share-og.service";
import { workspaceService } from "../services/workspace.service";
import { fail } from "./lib/respond";
import { appsAssetRoutes } from "./apps/assets";
import { appsBindingRoutes } from "./apps/bindings";
import { appsCurationRoutes } from "./apps/curation";
import { appsEnvRoutes } from "./apps/env";
import { appsFileRoutes } from "./apps/files";
import { appsGitBranchRoutes } from "./apps/git";
import { appsGithubRoutes } from "./apps/github";
import { appsHomeRoutes } from "./apps/home";
import { appsLiveRoutes } from "./apps/live";
import { appsProjectRoutes } from "./apps/projects";
import { appsPublishRoutes } from "./apps/publish";
import { appsSandboxRoutes } from "./apps/sandbox";
import { appsSharingRoutes } from "./apps/sharing";

export const appsRoutes = createRouter();

async function anonymousLiveLinkToViewer(
  c: Context,
  next: () => Promise<void>,
): Promise<Response | void> {
  // A link-preview crawler gets the viewer page's tags right here, with a
  // 200: WhatsApp (and others) do not follow the redirect for previews.
  // Browsers keep the 302 below.
  if (c.req.method === "GET" && isPreviewCrawler(c.req.header("user-agent"))) {
    const viewerPath = liveViewerRedirect({
      fetchDest: "document",
      fetchMode: "navigate",
      workspaceId: c.req.param("workspaceId"),
      ref: c.req.param("id"),
      path: c.req.path,
      url: c.req.url,
    });
    if (viewerPath) {
      const html = await timed("og.live", () =>
        crawlerPreviewPage(
          viewerPath,
          publicOrigin(c.req.url, c.req.header("x-forwarded-proto")),
        ),
      );
      return c.html(html, 200, { "Cache-Control": "no-cache" });
    }
  }
  const target =
    c.req.method === "GET"
      ? anonymousViewerRedirect({
          hasCredentials:
            !!c.req.header("authorization") ||
            !!getCookie(c, sessionManager.sessionCookieName),
          accept: c.req.header("accept"),
          userAgent: c.req.header("user-agent"),
          workspaceId: c.req.param("workspaceId"),
          ref: c.req.param("id"),
          path: c.req.path,
          url: c.req.url,
        })
      : null;
  if (target) return c.redirect(target, 302);
  await next();
}

// Step timings (Server-Timing + a log line when slow) for the Apps home's
// reads — registered first so the total includes auth. The live link's
// top-level page too: a crawler's link preview is built right there.
for (const [route, label] of [
  ["/", "apps.list"],
  ["/discovery", "apps.discovery"],
  ["/feed", "apps.feed"],
  ["/usage", "apps.usage"],
  ["/recent", "apps.recent"],
  ["/search", "apps.search"],
  ["/:id/thumbnail", "apps.thumbnail"],
  ["/:id/live", "apps.live"],
  ["/:id/live/", "apps.live"],
] as const) {
  appsRoutes.on("GET", route, serverTiming(label));
}

// A copied workspace link (`…/apps/<id>/live/`) opened without any session —
// a person signed out, or a chat app's link-preview crawler — goes to the
// viewer page instead of a 401: the page signs people in, and its HTML
// carries the app's link-preview tags (share-og.service). Only the app's
// top-level page, only for browsers and crawlers; API clients still get 401.
appsRoutes.use("/:id/live/*", anonymousLiveLinkToViewer);
appsRoutes.use("/:id/live", anonymousLiveLinkToViewer);

appsRoutes.use("*", unifiedAuthMiddleware);

appsRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId") as string;
  if (workspaceId) {
    const user = c.get("user");
    const workspace = c.get("workspace");
    if (workspace) {
      if (workspace._id.toString() !== workspaceId) {
        return fail(c, 403, "API key not authorized for this workspace");
      }
    } else if (user) {
      // A stranger from a trusted domain joins here — this is the request
      // their first click on a published app's link makes (apps.md §28).
      const member =
        (await timed("auth.member", () =>
          workspaceService.getMember(workspaceId, user.id),
        )) ?? (await ensureAutoJoin(workspaceId, user));
      if (!member) {
        return fail(c, 403, "Access denied to workspace");
      }
      // Shared sharing handlers read the role from context for admin access.
      c.set("memberRole", member.role);
    } else {
      return fail(c, 401, "Unauthorized");
    }
    enrichContextWithWorkspace(workspaceId);
  }
  await next();
});

// Git walks and sandbox round trips: capped per instance (2026-10-19 — one
// slow endpoint here starved the whole service). GET only, so a busy pool
// never refuses a save.
for (const route of ["/:id/branches", "/:id/files", "/:id/status"]) {
  appsRoutes.on("GET", route, concurrencyLimit(repoWorkPool));
}

// The sub-routers, in the order their routes were always registered: Hono
// tries routes in registration order, so every static path (`/folders`,
// `/usage`, `/archived/restore`, …) is mounted before the `/{id}…` routes
// that would otherwise read it as an app ref.
for (const routes of [
  appsGithubRoutes,
  appsProjectRoutes,
  appsHomeRoutes,
  appsCurationRoutes,
  appsFileRoutes,
  appsBindingRoutes,
  appsGitBranchRoutes,
  appsSandboxRoutes,
  appsPublishRoutes,
  appsLiveRoutes,
  appsSharingRoutes,
  appsEnvRoutes,
  appsAssetRoutes,
]) {
  appsRoutes.route("/", routes);
}

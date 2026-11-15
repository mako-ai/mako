/**
 * Viewing a published app (§13.2): the view token, the viewer identity, the
 * `/live` serving routes and the viewer's binding refresh.
 */
import { withQueryLabels } from "../../services/bigquery-labels";
import { createRoute, z } from "@hono/zod-openapi";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { recordServedOpen } from "../../apps/app-usage.service";
import { serveDeploymentFile } from "../../apps/deployment.service";
import { mintPublishedGrant } from "../../apps/preview.service";
import { appOriginFor, tokenWindowMs } from "../../apps/app-origin";
import {
  resolveAppViewer,
  resolveAppViewerByEmail,
} from "../../apps/app-viewer.service";
import { liveViewerRedirect } from "../../apps/live-viewer-redirect";
import {
  refreshBindingHttp,
  refreshBindingProgress,
} from "../../apps/binding-refresh";
import { wantsBindingProgress } from "../../apps/binding-progress";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import {
  ProjectParam,
  handleError,
  loadProject,
  loadPublishedRowById,
  viewerOf,
  actorOf,
} from "./shared";
import { fail } from "../lib/respond";

export const appsLiveRoutes = createRouter();

// ---------------------------------------------------------------------------
// Viewing a published app (§13.2)
// ---------------------------------------------------------------------------

/**
 * Serve the published deployment to a workspace user.
 *
 * Deliberately does NOT call ensureWorktree: viewing must never start a
 * sandbox, or a hundred readers become a hundred microVMs. Everything here
 * comes from the artifact store.
 *
 * `__data/<name>.parquet` resolves to the app's materialized binding for the
 * same project, authorized by the caller's normal workspace access — the
 * published counterpart to the preview's token-gated data path.
 */
async function serveLive(c: AuthenticatedContext): Promise<Response> {
  const viewerPage = liveViewerRedirect({
    fetchDest: c.req.header("sec-fetch-dest"),
    fetchMode: c.req.header("sec-fetch-mode"),
    workspaceId: c.req.param("workspaceId"),
    ref: c.req.param("id"),
    path: c.req.path,
    url: c.req.url,
  });
  if (viewerPage) return c.redirect(viewerPage, 302);
  const loaded = await loadProject(c, { write: false });
  if ("errorResponse" in loaded) return loaded.errorResponse;
  const project = loaded.project;
  const sha = project.publishedSha;
  if (!sha) {
    return fail(c, 404, "This app has not been published yet");
  }
  const projectId = project._id.toString();
  // Split on the id EXACTLY AS THE CALLER WROTE IT. Splitting on the project's
  // Mongo id broke the moment apps became addressable by folder name: the
  // marker never matched, so every asset request fell through to the SPA
  // fallback and the page silently served index.html as its own JavaScript.
  const ref = c.req.param("id") ?? projectId;
  const marker = `/apps/${ref}/live`;
  const at = c.req.path.indexOf(marker);
  const rest = at === -1 ? "" : c.req.path.slice(at + marker.length);

  const response = await serveDeploymentFile({
    projectId,
    sha,
    assetPath: rest.replace(/^\/+/, ""),
    viewer: viewerOf(c),
    progress: wantsBindingProgress(c.req.header("accept")),
  });
  if (response && loaded.userId) {
    // A raw `/live/` page load or a frame on another site; the in-Mako views
    // load from a view token and report themselves.
    recordServedOpen({
      workspaceId: project.workspaceId.toString(),
      appId: projectId,
      userId: loaded.userId,
      viewerKey: loaded.userId,
      fetchDest: c.req.header("sec-fetch-dest"),
      contentType: response.headers.get("content-type"),
      pageSource: "app",
      userAgent: c.req.header("user-agent"),
      referer: c.req.header("referer"),
      host: c.req.header("host"),
    });
  }
  return response ?? fail(c, 404, "Not found");
}

appsLiveRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/view-token",
    tags: ["Apps"],
    summary: "Mint a cookie-free token for the published app",
    description:
      "Viewing a published app happens in a sandboxed, opaque-origin iframe, and ES modules are always fetched in CORS mode WITHOUT credentials — so a cookie-authorized URL 401s there however well it works in a normal tab, and the app renders nothing. This returns the same kind of short-lived token the build preview uses, authorized here by the caller's workspace access. It starts no sandbox: the bytes come from the deployment store.",
    security: AUTH_SECURITY,
    request: { params: ProjectParam },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded =
        (await loadPublishedRowById(c)) ??
        (await loadProject(c, { write: false }));
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const sha = loaded.project.publishedSha;
      if (!sha) {
        return fail(c, 404, "This app has not been published yet");
      }
      const projectId = loaded.project._id.toString();
      // APPS_ORIGIN_BASE set: the app gets its own origin and a token that
      // is stable for a window, so the browser cache can work (app-origin.ts).
      const appOrigin = appOriginFor(projectId);
      const grant = mintPublishedGrant({
        workspaceId: loaded.project.workspaceId.toString(),
        projectId,
        sha,
        // Binds the token to this person: the cookie-free serving route
        // answers `__data/viewer.json` from it (apps.md §28).
        viewer: viewerOf(c) ?? undefined,
        ...(appOrigin ? { stableWindowMs: tokenWindowMs() } : {}),
      });
      return c.json(
        {
          success: true as const,
          token: grant.token,
          url: `${appOrigin ?? ""}/api/apps-preview/${grant.token}/`,
          sha,
          expiresAt: grant.expiresAt,
          // Which app the ref named: the client may ask by slug before its
          // app list has loaded, and files the token under this id.
          appId: loaded.project._id.toString(),
        },
        200,
      );
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsLiveRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/viewer",
    tags: ["Apps"],
    summary: "Who the caller is to this app (what `useViewer()` sees)",
    description:
      "What `__data/viewer.json` says for the caller: their id and email, " +
      "the workspace (id, name, their access role) and their role on this " +
      "app (owner / editor / viewer). Nothing else — an app looks up what " +
      "it needs about the person in the warehouse by email (apps.md §28). " +
      "Editors of the app may pass `?as=<email>` to see another member's " +
      "resolution; a laptop `vite dev` uses this for MAKO_VIEWER_AS.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      query: z.object({ as: z.string().optional() }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: false });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { as } = c.req.valid("query");
      const self = viewerOf(c);
      if (!self) {
        return fail(c, 403, "No signed-in viewer to resolve");
      }
      if (as && as.toLowerCase() !== self.email.toLowerCase()) {
        // Previewing as someone else is a builder's tool.
        const builder = await loadProject(c, { write: true });
        if ("errorResponse" in builder) return builder.errorResponse;
        const viewer = await resolveAppViewerByEmail(loaded.project, as);
        if (!viewer) {
          return fail(c, 404, `No Mako user has the email ${as}`);
        }
        return c.json({ success: true as const, viewer }, 200);
      }
      const viewer = await resolveAppViewer(loaded.project, self);
      return c.json({ success: true as const, viewer }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

appsLiveRoutes.get("/:id/live", serveLive);
appsLiveRoutes.get("/:id/live/*", serveLive);

/**
 * The published app's `POST __data/<name>/refresh` — the SDK's `refresh()`,
 * for a member viewing the app signed in (see binding-refresh.ts). Read
 * access is enough: the query that runs
 * is the owner's published SQL under the owner's connection, never the
 * viewer's. Rebuilds the binding AT the published commit, since that is the
 * artifact this viewer is reading.
 */
appsLiveRoutes.post("/:id/live/__data/:name/refresh", async c => {
  try {
    const loaded = await loadProject(c, { write: false });
    if ("errorResponse" in loaded) return loaded.errorResponse;
    const sha = loaded.project.publishedSha;
    if (!sha) {
      return fail(c, 404, "This app has not been published yet");
    }
    const input = {
      project: loaded.project,
      name: c.req.param("name"),
      actorId: actorOf(loaded),
      at: sha,
    };
    if (wantsBindingProgress(c.req.header("accept"))) {
      return await withQueryLabels({ mako_trigger: "viewer" }, async () =>
        refreshBindingProgress(input),
      );
    }
    const { status, body, headers } = await withQueryLabels(
      { mako_trigger: "viewer" },
      () => refreshBindingHttp(input),
    );
    return c.json(body, status, headers);
  } catch (error) {
    return handleError(c, error);
  }
});

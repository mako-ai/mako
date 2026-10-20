/**
 * Link-preview images for in-app app links — intentionally public.
 *
 * Classification: Intentionally public. Chat-app crawlers fetching an
 * `og:image` are never signed in, so this answers without a session — but
 * only for an app every member of its workspace can already see (a
 * workspace-tree app with workspace-wide access, in a workspace that has not
 * turned link previews off). Same rule as the tags (share-og.service).
 *
 *   GET /api/og/app-image/:workspaceId/:appId — the app's raster thumbnail
 */
import { createRoute, z } from "@hono/zod-openapi";
import { OPEN_RESPONSES, createRouter } from "../openapi/core";
import { loggers } from "../logging";
import { serverTiming, timed } from "../middleware/server-timing";
import {
  previewableWorkspaceApp,
  rasterThumbnail,
} from "../services/share-og.service";

const logger = loggers.api("og");

export const ogRoutes = createRouter();

// Step timings (Server-Timing + a log line when slow): crawlers give up at
// ~5 s, so a slow preview image must be visible from its response.
ogRoutes.use("/app-image/*", serverTiming("og.appImage"));

const AppImageParams = z.object({
  workspaceId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .openapi({ param: { name: "workspaceId", in: "path" } }),
  appId: z
    .string()
    .regex(/^[0-9a-fA-F]{24}$/)
    .openapi({ param: { name: "appId", in: "path" } }),
});

ogRoutes.openapi(
  createRoute({
    method: "get",
    path: "/app-image/{workspaceId}/{appId}",
    tags: ["Public Shares"],
    summary: "Link-preview image of a workspace app",
    description:
      "The app's own raster thumbnail (thumbnail.png/.jpg/.webp), as a JPEG at most 1200 px wide and ~300 KB (so WhatsApp shows the large card), for Open Graph crawlers unfurling an in-app link. Only for a workspace-tree app visible to the whole workspace, while the workspace's link previews are on; otherwise — or for an SVG-only app — 404, and the page points crawlers at the generic /og-default.png. Cached publicly by blob oid.",
    security: [],
    request: { params: AppImageParams },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const { workspaceId, appId } = c.req.valid("param");
      const row = await timed("app.lookup", () =>
        previewableWorkspaceApp(workspaceId.toLowerCase(), appId.toLowerCase()),
      );
      // The ref must resolve to THIS id: a slug or path is not accepted here.
      const image =
        row && row.appId === appId.toLowerCase()
          ? await rasterThumbnail(workspaceId.toLowerCase(), row.thumbnail)
          : null;
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
          "Cache-Control": "public, max-age=86400",
          ETag: image.etag,
          "X-Content-Type-Options": "nosniff",
        },
      });
    } catch (error) {
      logger.error("Error serving app preview image", { error });
      return c.json({ success: false, error: "Failed to load image" }, 500);
    }
  },
);

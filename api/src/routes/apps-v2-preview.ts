/**
 * Apps v2 preview asset serving.
 *
 * Classification: Intentionally public (token-gated). The unguessable,
 * short-lived preview token minted by POST /apps-v2/:id/preview is the sole
 * credential — no cookies, no session — so the previewed app can run in a
 * sandboxed (opaque-origin) iframe without any Mako credentials in scope.
 * 404 unless APPS_V2_ENABLED.
 */
import { createRoute, z } from "@hono/zod-openapi";
import { isAppsV2Enabled } from "../apps-v2/config";
import {
  readPreviewAsset,
  resolvePreviewGrant,
} from "../apps-v2/preview.service";
import { OPEN_RESPONSES, createRouter } from "../openapi/core";

export const appsV2PreviewRoutes = createRouter();

appsV2PreviewRoutes.use("*", async (c, next) => {
  if (!isAppsV2Enabled()) {
    return c.json({ success: false, error: "Not found" }, 404);
  }
  await next();
});

appsV2PreviewRoutes.openapi(
  createRoute({
    method: "get",
    path: "/:token/:assetPath{.*}",
    tags: ["Apps v2"],
    summary: "Serve a built preview asset (token-gated, cookie-free)",
    security: [],
    request: {
      params: z.object({
        token: z.string(),
        assetPath: z.string().optional(),
      }),
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    const token = c.req.param("token");
    const assetPath = c.req.param("assetPath") ?? "";
    const grant = token ? resolvePreviewGrant(token) : null;
    if (!grant) {
      return c.json(
        { success: false, error: "Preview expired — rebuild to get a new link" },
        404,
      );
    }
    const asset = await readPreviewAsset(grant, assetPath);
    if (!asset) {
      return c.json({ success: false, error: "Not found" }, 404);
    }
    return c.body(new Uint8Array(asset.contents), 200, {
      "Content-Type": asset.contentType,
      "Cache-Control": "no-store",
      // Belt-and-braces: previewed code must never be framed as-if-Mako.
      "X-Content-Type-Options": "nosniff",
    });
  },
);

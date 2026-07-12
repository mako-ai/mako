/**
 * Apps v2 preview asset serving.
 *
 * Classification: Intentionally public (token-gated). The unguessable,
 * short-lived preview token minted by POST /apps-v2/:id/preview is the sole
 * credential — no cookies, no session — so the previewed app can run in a
 * sandboxed (opaque-origin) iframe without any Mako credentials in scope.
 * 404 unless APPS_V2_ENABLED.
 *
 * Plain Hono routes (NOT .openapi()): the asset path spans slashes, which
 * zod-openapi's `{param}` syntax cannot express. Static asset serving does
 * not belong in the API reference anyway.
 */
import type { Context } from "hono";
import { isAppsV2Enabled } from "../apps-v2/config";
import {
  readPreviewAsset,
  resolvePreviewGrant,
} from "../apps-v2/preview.service";
import { createRouter } from "../openapi/core";

export const appsV2PreviewRoutes = createRouter();

appsV2PreviewRoutes.use("*", async (c, next) => {
  if (!isAppsV2Enabled()) {
    return c.json({ success: false, error: "Not found" }, 404);
  }
  await next();
});

async function serveAsset(c: Context): Promise<Response> {
  const token = c.req.param("token");
  const grant = token ? resolvePreviewGrant(token) : null;
  if (!grant) {
    return c.json(
      { success: false, error: "Preview expired — rebuild to get a new link" },
      404,
    );
  }
  // Everything after "/<token>/" is the asset path ("" -> index.html).
  const prefix = `/api/apps-v2-preview/${token}/`;
  const assetPath = c.req.path.startsWith(prefix)
    ? decodeURIComponent(c.req.path.slice(prefix.length))
    : "";
  const asset = await readPreviewAsset(grant, assetPath);
  if (!asset) {
    return c.json({ success: false, error: "Not found" }, 404);
  }
  return c.body(new Uint8Array(asset.contents), 200, {
    "Content-Type": asset.contentType,
    "Cache-Control": "no-store",
    // Belt-and-braces: previewed code must never be served as-if-Mako HTML.
    "X-Content-Type-Options": "nosniff",
    // The preview iframe is sandboxed WITHOUT allow-same-origin, so its
    // origin is opaque and Vite's `<script crossorigin type="module">` tags
    // fetch in CORS mode with `Origin: null`. Assets here are token-gated
    // and cookie-free, so a wildcard is safe and required for modules to run.
    "Access-Control-Allow-Origin": "*",
  });
}

appsV2PreviewRoutes.get("/:token", serveAsset);
appsV2PreviewRoutes.get("/:token/*", serveAsset);

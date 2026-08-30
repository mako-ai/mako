/**
 * Apps preview asset serving.
 *
 * Classification: Intentionally public (token-gated). The unguessable,
 * short-lived preview token minted by POST /apps/:id/preview is the sole
 * credential — no cookies, no session — so the previewed app can run in a
 * sandboxed (opaque-origin) iframe without any Mako credentials in scope.
 *
 * Plain Hono routes (NOT .openapi()): the asset path spans slashes, which
 * zod-openapi's `{param}` syntax cannot express. Static asset serving does
 * not belong in the API reference anyway.
 */
import { Readable } from "node:stream";
import type { Context } from "hono";
import { bindingArtifactKeyByName } from "../apps/bindings.service";
import { AppProject } from "../database/workspace-schema";
import { serveDeploymentFile } from "../apps/deployment.service";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";
import { readPreviewAsset, resolvePreviewGrant } from "../apps/preview.service";
import { createRouter } from "../openapi/core";

export const appsPreviewRoutes = createRouter();

function assetPathFor(c: Context, token: string): string {
  // Everything after "/<token>/" is the asset path ("" -> index.html).
  const prefix = `/api/apps-preview/${token}/`;
  return c.req.path.startsWith(prefix)
    ? decodeURIComponent(c.req.path.slice(prefix.length))
    : "";
}

// Headers that must never be forwarded verbatim to (or from) the proxied
// dev server — hop-by-hop / connection-management, not payload semantics.

async function serveAsset(c: Context): Promise<Response> {
  const token = c.req.param("token");
  const grant = token ? resolvePreviewGrant(token) : null;
  if (!grant || !token) {
    return c.json(
      { success: false, error: "Preview expired — rebuild to get a new link" },
      404,
    );
  }
  // A published deployment is served from the artifact store, not a
  // directory — but through the same token, because the reason for the token
  // is the sandboxed iframe, which does not care where the bytes come from.
  if (grant.publishedSha) {
    const response = await serveDeploymentFile({
      projectId: grant.projectId,
      sha: grant.publishedSha,
      assetPath: assetPathFor(c, token),
      // The token is the only credential, so nothing in between should keep
      // a copy of a private app's build.
      private: true,
    });
    if (!response) {
      return c.json({ success: false, error: "Not found" }, 404);
    }
    // The iframe has an OPAQUE origin (sandboxed without allow-same-origin)
    // and ES modules are always fetched in CORS mode — so without this the
    // browser blocks the app's own script and the page renders blank while
    // every request in the network panel reads 200. The same header the
    // static preview below sets, for the same reason.
    const headers = new Headers(response.headers);
    headers.set("Access-Control-Allow-Origin", "*");
    return new Response(response.body, { status: response.status, headers });
  }

  // Data bindings: `__data/<name>.parquet` (app-relative, so it works under
  // the token prefix in BOTH static and dev previews). Streams the
  // materialized artifact for this project — served BEFORE the dev proxy so
  // vite never sees it.
  const dataMatch = assetPathFor(c, token).match(
    /^__data\/([A-Za-z0-9_][A-Za-z0-9_-]*)\.parquet$/,
  );
  if (dataMatch) {
    const store = getDashboardArtifactStore();
    const project = await AppProject.findById(grant.projectId);
    const key = project
      ? await bindingArtifactKeyByName(project, dataMatch[1], "")
      : null;
    const stream = key ? await store.openReadStream(key) : null;
    if (!key || !stream) {
      return c.json(
        { success: false, error: `Binding "${dataMatch[1]}" not materialized` },
        404,
      );
    }
    // Content-Length is required: parquet readers (hyparquet's
    // asyncBufferFromUrl, duckdb-wasm) need the size (or Range support) to
    // read the footer.
    const size = await store.getSize(key);
    return new Response(Readable.toWeb(stream as Readable) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apache.parquet",
        ...(size !== null ? { "Content-Length": String(size) } : {}),
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  const asset = await readPreviewAsset(grant, assetPathFor(c, token));
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

appsPreviewRoutes.get("/:token", serveAsset);
appsPreviewRoutes.get("/:token/*", serveAsset);
appsPreviewRoutes.post("/:token/*", serveAsset);

/**
 * Apps v2 preview asset serving.
 *
 * Classification: Intentionally public (token-gated). The unguessable,
 * short-lived preview token minted by POST /apps-v2/:id/preview is the sole
 * credential — no cookies, no session — so the previewed app can run in a
 * sandboxed (opaque-origin) iframe without any Mako credentials in scope.
 *
 * Plain Hono routes (NOT .openapi()): the asset path spans slashes, which
 * zod-openapi's `{param}` syntax cannot express. Static asset serving does
 * not belong in the API reference anyway.
 */
import { Readable } from "node:stream";
import type { Context } from "hono";
import { bindingArtifactKey } from "../apps-v2/bindings.service";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";
import {
  readPreviewAsset,
  resolvePreviewGrant,
} from "../apps-v2/preview.service";
import { createRouter } from "../openapi/core";

export const appsV2PreviewRoutes = createRouter();

function assetPathFor(c: Context, token: string): string {
  // Everything after "/<token>/" is the asset path ("" -> index.html).
  const prefix = `/api/apps-v2-preview/${token}/`;
  return c.req.path.startsWith(prefix)
    ? decodeURIComponent(c.req.path.slice(prefix.length))
    : "";
}

// Headers that must never be forwarded verbatim to (or from) the proxied
// dev server — hop-by-hop / connection-management, not payload semantics.
const HOP_BY_HOP = new Set([
  "connection",
  "keep-alive",
  "transfer-encoding",
  "upgrade",
  "host",
  "content-length",
]);

/**
 * Reverse-proxy a request to a live `vite dev` process (dev grants only).
 * Unlike the static grant's asset lookup, this forwards the FULL original
 * path (token prefix included) — the vite process was started with
 * `--base=/api/apps-v2-preview/<token>/` (see dev-server.service.ts), so it
 * expects requests, and generates its own asset references, at that exact
 * prefix rather than the site root.
 */
async function proxyToDevServer(
  c: Context,
  devPort: number,
): Promise<Response> {
  const url = new URL(c.req.url);
  const target = `http://127.0.0.1:${devPort}${url.pathname}${url.search}`;
  const headers = new Headers();
  c.req.raw.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) headers.set(key, value);
  });

  let upstream: Response;
  try {
    upstream = await fetch(target, {
      method: c.req.method,
      headers,
      body: ["GET", "HEAD"].includes(c.req.method)
        ? undefined
        : await c.req.arrayBuffer(),
      // @ts-expect-error -- Node's fetch requires this for streamed request bodies.
      duplex: "half",
    });
  } catch {
    return c.json(
      { success: false, error: "Dev server is not responding" },
      502,
    );
  }

  const outHeaders = new Headers();
  upstream.headers.forEach((value, key) => {
    if (!HOP_BY_HOP.has(key.toLowerCase())) outHeaders.set(key, value);
  });
  // Same reasoning as the static server: the preview iframe is sandboxed
  // WITHOUT allow-same-origin (opaque origin), so module fetches carry
  // `Origin: null` — token-gated and cookie-free, so a wildcard is safe.
  outHeaders.set("Access-Control-Allow-Origin", "*");
  outHeaders.set("X-Content-Type-Options", "nosniff");
  return new Response(upstream.body, {
    status: upstream.status,
    headers: outHeaders,
  });
}

async function serveAsset(c: Context): Promise<Response> {
  const token = c.req.param("token");
  const grant = token ? resolvePreviewGrant(token) : null;
  if (!grant || !token) {
    return c.json(
      { success: false, error: "Preview expired — rebuild to get a new link" },
      404,
    );
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
    const key = bindingArtifactKey(grant.projectId, dataMatch[1]);
    const stream = await store.openReadStream(key);
    if (!stream) {
      return c.json(
        { success: false, error: `Binding "${dataMatch[1]}" not materialized` },
        404,
      );
    }
    return new Response(Readable.toWeb(stream as Readable) as ReadableStream, {
      status: 200,
      headers: {
        "Content-Type": "application/vnd.apache.parquet",
        "Cache-Control": "no-store",
        "Access-Control-Allow-Origin": "*",
      },
    });
  }

  if (grant.devPort) {
    return proxyToDevServer(c, grant.devPort);
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

appsV2PreviewRoutes.get("/:token", serveAsset);
appsV2PreviewRoutes.get("/:token/*", serveAsset);
appsV2PreviewRoutes.post("/:token/*", serveAsset);

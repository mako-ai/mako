/**
 * Draft-app preview endpoints, authenticated by a signed preview token
 * (see app-preview-token.service). Intentionally public routes — the token
 * IS the authorization: single app, minutes-scale TTL, read/execute only.
 *
 * This is the server half of the headless iteration loop: an external agent
 * (via the MCP `create_preview_token` tool) mints a token, opens
 * `<CLIENT_URL>/preview/<token>` in a browser (its own, or the server-side
 * render_app pool), and the page loads the DRAFT definition + runs the
 * draft's stored bindings through these endpoints. No session cookie or API
 * key ever reaches the rendered page.
 *
 * JSON-RPC-free plain REST, but deliberately NOT part of the documented
 * OpenAPI surface (tokens are ephemeral machine credentials, not an API).
 */
import { Readable } from "node:stream";

import { Hono } from "hono";
import { Types } from "mongoose";

import { MakoApp } from "../database/workspace-schema";
import {
  buildAppSnapshot,
  type AppSnapshot,
} from "../services/app-version.service";
import { getBindingArtifactInfo } from "../services/app-binding-materialization.service";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";
import { verifyAppPreviewToken } from "../services/app-preview-token.service";
import { executeAppPreviewBinding } from "../services/public-live-query.service";
import { loggers } from "../logging";

const logger = loggers.api("app-preview");

export const appPreviewRoutes = new Hono();

async function loadAppForToken(token: string) {
  const grant = verifyAppPreviewToken(token);
  if (!grant) return null;
  if (
    !Types.ObjectId.isValid(grant.appId) ||
    !Types.ObjectId.isValid(grant.workspaceId)
  ) {
    return null;
  }
  const doc = await MakoApp.findOne({
    _id: new Types.ObjectId(grant.appId),
    workspaceId: new Types.ObjectId(grant.workspaceId),
  });
  return doc ? { doc, grant } : null;
}

// GET /:token — the DRAFT definition, shaped like the public share content so
// the frontend viewer machinery is reusable. `useQuery` bindings always
// execute live server-side (fresh draft data, no publish required), while
// materialized (parquet) bindings additionally expose their artifact so the
// preview can hydrate DuckDB and serve `useDuckDB` — the same data layer the
// real app runs on. A parquet binding with no built artifact stays live-only
// until the agent calls materialize_binding.
appPreviewRoutes.get("/:token", async c => {
  try {
    const token = c.req.param("token");
    const loaded = await loadAppForToken(token);
    if (!loaded) {
      return c.json(
        { success: false, error: "Preview link is invalid or expired" },
        404,
      );
    }
    const { doc, grant } = loaded;
    const def = buildAppSnapshot(doc) as AppSnapshot;
    // Materialization artifacts are server-owned and keyed by binding id; the
    // snapshot intentionally excludes `cache`, so read it off the live doc
    // (mirrors buildAppContent in public-share.ts).
    const liveCacheById = new Map(
      (doc.dataBindings || []).map(b => [b.id, b.cache]),
    );
    return c.json({
      success: true,
      data: {
        type: "app" as const,
        title: def.title,
        description: def.description,
        entrypoint: def.entrypoint,
        allowLiveQueries: true,
        expiresAt: grant.expiresAt.toISOString(),
        files: (def.files || []).map(f => ({
          path: f.path,
          contents: f.contents,
        })),
        dependencies: def.dependencies || {},
        dataBindings: (
          (def.dataBindings || []) as Array<Record<string, unknown>>
        ).map(b => {
          const cache = liveCacheById.get(b.id as string);
          const ready =
            b.materialization === "parquet" &&
            cache?.parquetBuildStatus === "ready" &&
            !!cache?.parquetArtifactKey;
          return {
            id: b.id,
            name: b.name,
            materialization: (b.materialization ?? "live") as
              | "live"
              | "parquet",
            ready,
            rowCount: cache?.rowCount ?? null,
            materializedAt: cache?.parquetBuiltAt ?? null,
            artifactUrl: ready
              ? `/api/preview/${token}/binding/${encodeURIComponent(String(b.id))}/artifact?rev=${encodeURIComponent(cache?.artifactRevision || "")}`
              : null,
          };
        }),
      },
    });
  } catch (error) {
    logger.error("Preview content failed", { error });
    return c.json({ success: false, error: "Failed to load preview" }, 500);
  }
});

// GET /:token/binding/:bindingId/artifact — stream a materialized binding's
// parquet snapshot so the preview page can hydrate DuckDB (mirrors the public
// share artifact route; the token IS the authorization, read-only).
appPreviewRoutes.get("/:token/binding/:bindingId/artifact", async c => {
  try {
    const loaded = await loadAppForToken(c.req.param("token"));
    if (!loaded) {
      return c.json(
        { success: false, error: "Preview link is invalid or expired" },
        404,
      );
    }
    const info = getBindingArtifactInfo(loaded.doc, c.req.param("bindingId"));
    if (!info) {
      return c.json({ success: false, error: "Artifact not found" }, 404);
    }
    const stream = await getDashboardArtifactStore().openReadStream(
      info.artifactKey,
    );
    if (!stream) {
      return c.json({ success: false, error: "Artifact not found" }, 404);
    }
    const rev = c.req.query("rev");
    const cacheControl =
      rev && info.revision && rev === info.revision
        ? "private, max-age=86400, immutable"
        : "private, no-store";
    return c.body(Readable.toWeb(stream as Readable) as ReadableStream, 200, {
      "Content-Type": "application/vnd.apache.parquet",
      "X-Row-Count": String(info.rowCount ?? 0),
      "Cache-Control": cacheControl,
    });
  } catch (error) {
    logger.error("Preview artifact streaming failed", { error });
    return c.json({ success: false, error: "Failed to serve artifact" }, 500);
  }
});

// POST /:token/binding/:bindingId/execute — run one DRAFT binding (stored
// code only; read-only-checked, row-capped, timed out, rate-limited).
appPreviewRoutes.post("/:token/binding/:bindingId/execute", async c => {
  try {
    const token = c.req.param("token");
    const loaded = await loadAppForToken(token);
    if (!loaded) {
      return c.json(
        { success: false, error: "Preview link is invalid or expired" },
        404,
      );
    }
    const result = await executeAppPreviewBinding({
      app: loaded.doc,
      bindingId: c.req.param("bindingId"),
      token,
    });
    if (!result.success) {
      return c.json(
        { success: false, error: result.error },
        result.status as 400,
      );
    }
    return c.json({
      success: true,
      rows: result.rows,
      fields: result.fields,
      rowCount: result.rowCount,
      cached: result.cached,
    });
  } catch (error) {
    logger.error("Preview binding execution failed", { error });
    return c.json({ success: false, error: "Failed to run data source" }, 500);
  }
});

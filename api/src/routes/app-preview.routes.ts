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
import { Hono } from "hono";
import { Types } from "mongoose";

import { MakoApp } from "../database/workspace-schema";
import {
  buildAppSnapshot,
  type AppSnapshot,
} from "../services/app-version.service";
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
// the frontend viewer machinery is reusable. Every binding is presented as
// "live": preview always executes the draft's stored code server-side, so an
// agent sees current data without waiting on parquet re-materialization.
appPreviewRoutes.get("/:token", async c => {
  try {
    const loaded = await loadAppForToken(c.req.param("token"));
    if (!loaded) {
      return c.json(
        { success: false, error: "Preview link is invalid or expired" },
        404,
      );
    }
    const { doc, grant } = loaded;
    const def = buildAppSnapshot(doc) as AppSnapshot;
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
        ).map(b => ({
          id: b.id,
          name: b.name,
          materialization: "live" as const,
          ready: false,
          rowCount: null,
          materializedAt: null,
          artifactUrl: null,
        })),
      },
    });
  } catch (error) {
    logger.error("Preview content failed", { error });
    return c.json({ success: false, error: "Failed to load preview" }, 500);
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

/**
 * Super Admin Routes
 *
 * Cross-workspace administration endpoints, all gated on the
 * `SUPER_ADMIN_EMAILS` allow-list via `requireSuperAdmin`.
 *
 * Mounted at `/api/admin/*` from api/src/index.ts.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { requireSuperAdmin } from "../auth/super-admin";
import { loggers } from "../logging";
import {
  adminHardRefreshCatalog,
  adminRefreshCatalog,
  getAdminCatalogView,
  setCuratedDefaults,
  setCuratedModel,
} from "../services/model-catalog.service";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";

const logger = loggers.app();

export const adminRoutes = createRouter();

const OpenBody = {
  required: false,
  content: {
    "application/json": { schema: z.record(z.string(), z.any()) },
  },
};

// Every admin route requires an authenticated session AND a super-admin email.
adminRoutes.use("*", unifiedAuthMiddleware);
adminRoutes.use("*", requireSuperAdmin);

// ---------------------------------------------------------------------------
// GET /api/admin/catalog
// Returns the merged gateway × curation view for the admin UI.
// ---------------------------------------------------------------------------
adminRoutes.openapi(
  createRoute({
    method: "get",
    path: "/catalog",
    tags: ["Admin"],
    summary: "Get model catalog (admin)",
    security: AUTH_SECURITY,
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const view = await getAdminCatalogView();
      return c.json({ success: true, ...view });
    } catch (err) {
      logger.error("Admin catalog GET failed", { error: String(err) });
      return c.json(
        {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/catalog/refresh
// Pulls the latest gateway snapshot, persists the error (if any), and warms
// the in-memory catalog.
// ---------------------------------------------------------------------------
adminRoutes.openapi(
  createRoute({
    method: "post",
    path: "/catalog/refresh",
    tags: ["Admin"],
    summary: "Refresh model catalog (admin)",
    security: AUTH_SECURITY,
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const result = await adminRefreshCatalog();
    if (!result.ok) {
      return c.json({ success: false, error: result.error }, 502);
    }
    const view = await getAdminCatalogView();
    return c.json({
      success: true,
      refreshed: {
        models: result.models,
        pricedModels: result.pricedModels,
      },
      ...view,
    });
  },
);

// ---------------------------------------------------------------------------
// POST /api/admin/catalog/hard-refresh
// Resilient refresh: drops only malformed upstream rows (instead of skipping
// the whole snapshot) and busts BOTH the catalog and gateway-models caches.
// ---------------------------------------------------------------------------
adminRoutes.post("/catalog/hard-refresh", async c => {
  const result = await adminHardRefreshCatalog();
  if (!result.ok) {
    return c.json({ success: false, error: result.error }, 502);
  }
  const view = await getAdminCatalogView();
  return c.json({
    success: true,
    refreshed: {
      models: result.models,
      pricedModels: result.pricedModels,
      droppedEntries: result.droppedEntries,
    },
    ...view,
  });
});

// ---------------------------------------------------------------------------
// PUT /api/admin/catalog/models/:modelId
// Body: { visible?: boolean, tier?: "free" | "pro" }
// Upserts the curation entry for a single model.
// ---------------------------------------------------------------------------
adminRoutes.openapi(
  createRoute({
    method: "put",
    path: "/catalog/models/{modelId}",
    tags: ["Admin"],
    summary: "Curate a model (admin)",
    security: AUTH_SECURITY,
    request: {
      params: z.object({
        modelId: z.string().openapi({ param: { name: "modelId", in: "path" } }),
      }),
      body: OpenBody,
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const modelId = c.req.param("modelId");
      if (!modelId) {
        return c.json({ success: false, error: "modelId is required" }, 400);
      }
      const body = (await c.req.json()) as {
        visible?: unknown;
        tier?: unknown;
      };

      const update: { visible?: boolean; tier?: "free" | "pro" } = {};
      if (typeof body.visible === "boolean") update.visible = body.visible;
      if (body.tier === "free" || body.tier === "pro") update.tier = body.tier;

      if (update.visible === undefined && update.tier === undefined) {
        return c.json(
          {
            success: false,
            error: "Body must include `visible` and/or `tier`",
          },
          400,
        );
      }

      await setCuratedModel(modelId, update);
      const view = await getAdminCatalogView();
      return c.json({ success: true, ...view });
    } catch (err) {
      logger.error("Admin catalog model PUT failed", {
        error: String(err),
        modelId: c.req.param("modelId"),
      });
      return c.json(
        {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  },
);

// ---------------------------------------------------------------------------
// PUT /api/admin/catalog/defaults
// Body: { defaultChatModelId?, defaultFreeChatModelId?, utilityModelId? }
//   (each string | null)
// ---------------------------------------------------------------------------
adminRoutes.openapi(
  createRoute({
    method: "put",
    path: "/catalog/defaults",
    tags: ["Admin"],
    summary: "Set curated model defaults (admin)",
    security: AUTH_SECURITY,
    request: { body: OpenBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const body = (await c.req.json()) as {
        defaultChatModelId?: unknown;
        defaultFreeChatModelId?: unknown;
        utilityModelId?: unknown;
      };

      const update: {
        defaultChatModelId?: string | null;
        defaultFreeChatModelId?: string | null;
        utilityModelId?: string | null;
      } = {};

      if (body.defaultChatModelId !== undefined) {
        update.defaultChatModelId =
          body.defaultChatModelId === null
            ? null
            : typeof body.defaultChatModelId === "string"
              ? body.defaultChatModelId
              : null;
      }
      if (body.defaultFreeChatModelId !== undefined) {
        update.defaultFreeChatModelId =
          body.defaultFreeChatModelId === null
            ? null
            : typeof body.defaultFreeChatModelId === "string"
              ? body.defaultFreeChatModelId
              : null;
      }
      if (body.utilityModelId !== undefined) {
        update.utilityModelId =
          body.utilityModelId === null
            ? null
            : typeof body.utilityModelId === "string"
              ? body.utilityModelId
              : null;
      }

      await setCuratedDefaults(update);
      const view = await getAdminCatalogView();
      return c.json({ success: true, ...view });
    } catch (err) {
      logger.error("Admin catalog defaults PUT failed", { error: String(err) });
      return c.json(
        {
          success: false,
          error: err instanceof Error ? err.message : String(err),
        },
        500,
      );
    }
  },
);

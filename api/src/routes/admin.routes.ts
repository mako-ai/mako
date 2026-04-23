/**
 * Super Admin Routes
 *
 * Cross-workspace administration endpoints, all gated on the
 * `SUPER_ADMIN_EMAILS` allow-list via `requireSuperAdmin`.
 *
 * Mounted at `/api/admin/*` from api/src/index.ts.
 */

import { Hono } from "hono";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { requireSuperAdmin } from "../auth/super-admin";
import { loggers } from "../logging";
import {
  adminRefreshCatalog,
  getAdminCatalogView,
  setCuratedDefaults,
  setCuratedModel,
} from "../services/model-catalog.service";

const logger = loggers.app();

export const adminRoutes = new Hono();

// Every admin route requires an authenticated session AND a super-admin email.
adminRoutes.use("*", unifiedAuthMiddleware);
adminRoutes.use("*", requireSuperAdmin);

// ---------------------------------------------------------------------------
// GET /api/admin/catalog
// Returns the merged gateway × curation view for the admin UI.
// ---------------------------------------------------------------------------
adminRoutes.get("/catalog", async c => {
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
});

// ---------------------------------------------------------------------------
// POST /api/admin/catalog/refresh
// Pulls the latest gateway snapshot, persists the error (if any), and warms
// the in-memory catalog.
// ---------------------------------------------------------------------------
adminRoutes.post("/catalog/refresh", async c => {
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
});

// ---------------------------------------------------------------------------
// PUT /api/admin/catalog/models/:modelId
// Body: { visible?: boolean, tier?: "free" | "pro" }
// Upserts the curation entry for a single model.
// ---------------------------------------------------------------------------
adminRoutes.put("/catalog/models/:modelId", async c => {
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
});

// ---------------------------------------------------------------------------
// PUT /api/admin/catalog/defaults
// Body: { defaultChatModelId?: string | null, defaultFreeChatModelId?: string | null }
// ---------------------------------------------------------------------------
adminRoutes.put("/catalog/defaults", async c => {
  try {
    const body = (await c.req.json()) as {
      defaultChatModelId?: unknown;
      defaultFreeChatModelId?: unknown;
    };

    const update: {
      defaultChatModelId?: string | null;
      defaultFreeChatModelId?: string | null;
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
});

import { Hono } from "hono";
import { Dashboard, SavedConsole } from "../database/workspace-schema";
import { Types } from "mongoose";
import { nanoid } from "nanoid";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "../middleware/workspace.middleware";

const logger = loggers.api("dashboards");

const app = new Hono();

app.use("*", unifiedAuthMiddleware);

app.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) {
    if (!Types.ObjectId.isValid(workspaceId)) {
      return c.json(
        { success: false, error: "Invalid workspace ID format" },
        400,
      );
    }

    const user = c.get("user");
    const workspace = c.get("workspace");

    if (workspace) {
      if (workspace._id.toString() !== workspaceId) {
        return c.json(
          {
            success: false,
            error: "API key not authorized for this workspace",
          },
          403,
        );
      }
      c.set("memberRole", "admin");
    } else if (user) {
      const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
      if (!hasAccess) {
        return c.json(
          { success: false, error: "Access denied to workspace" },
          403,
        );
      }
      const member = await workspaceService.getMember(workspaceId, user.id);
      if (member) c.set("memberRole", member.role);
    } else {
      return c.json({ success: false, error: "Unauthorized" }, 401);
    }

    enrichContextWithWorkspace(workspaceId);
  }
  await next();
});

// GET /api/workspaces/:workspaceId/dashboards - List dashboards for workspace
app.get("/", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const userId = c.get("user")?.id;

    const dashboards = await Dashboard.find({
      workspaceId: new Types.ObjectId(workspaceId),
      $or: [{ access: "workspace" }, { access: "private", createdBy: userId }],
    })
      .sort({ updatedAt: -1 })
      .lean();

    return c.json({ success: true, data: dashboards });
  } catch (error) {
    logger.error("Error listing dashboards", { error });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// POST /api/workspaces/:workspaceId/dashboards - Create dashboard
app.post("/", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const user = c.get("user");
    const userId = user?.id ?? "system";
    const body = await c.req.json();

    if (!body.title || typeof body.title !== "string" || !body.title.trim()) {
      return c.json({ success: false, error: "title is required" }, 400);
    }

    if (body.dataSources && !Array.isArray(body.dataSources)) {
      return c.json(
        { success: false, error: "dataSources must be an array" },
        400,
      );
    }

    // Validate console references exist in this workspace
    const dataSources = body.dataSources || [];
    const consoleIds = dataSources
      .filter((ds: any) => ds.consoleId)
      .map((ds: any) => ds.consoleId);

    if (consoleIds.length > 0) {
      const validConsoles = await SavedConsole.countDocuments({
        _id: { $in: consoleIds.map((id: string) => new Types.ObjectId(id)) },
        workspaceId: new Types.ObjectId(workspaceId),
      });
      if (validConsoles !== consoleIds.length) {
        return c.json(
          {
            success: false,
            error: "One or more console references are invalid",
          },
          400,
        );
      }
    }

    const dashboard = new Dashboard({
      ...body,
      workspaceId: new Types.ObjectId(workspaceId),
      createdBy: userId,
    });

    await dashboard.save();

    return c.json({ success: true, data: dashboard });
  } catch (error) {
    logger.error("Error creating dashboard", { error });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// GET /api/workspaces/:workspaceId/dashboards/:id - Get dashboard by ID
app.get("/:id", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");

    const dashboard = await Dashboard.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!dashboard) {
      return c.json({ success: false, error: "Dashboard not found" }, 404);
    }

    const userId = c.get("user")?.id;
    if (dashboard.access === "private" && dashboard.createdBy !== userId) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }

    return c.json({ success: true, data: dashboard });
  } catch (error) {
    logger.error("Error getting dashboard", { error });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// PUT /api/workspaces/:workspaceId/dashboards/:id - Full update
app.put("/:id", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    const body = await c.req.json();

    const dashboard = await Dashboard.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!dashboard) {
      return c.json({ success: false, error: "Dashboard not found" }, 404);
    }

    const userId = c.get("user")?.id;
    if (dashboard.access === "private" && dashboard.createdBy !== userId) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    if (dashboard.access === "workspace" && dashboard.createdBy !== userId) {
      const memberRole = c.get("memberRole");
      if (memberRole !== "owner" && memberRole !== "admin") {
        return c.json(
          {
            success: false,
            error: "Only the owner or admins can edit this dashboard",
          },
          403,
        );
      }
    }

    if (body.title !== undefined) dashboard.title = body.title;
    if (body.description !== undefined)
      dashboard.description = body.description;
    if (body.dataSources !== undefined)
      dashboard.dataSources = body.dataSources;
    if (body.widgets !== undefined) dashboard.widgets = body.widgets;
    if (body.relationships !== undefined)
      dashboard.relationships = body.relationships;
    if (body.globalFilters !== undefined)
      dashboard.globalFilters = body.globalFilters;
    if (body.layout !== undefined) dashboard.layout = body.layout;
    if (body.crossFilter !== undefined)
      dashboard.crossFilter = body.crossFilter;
    if (body.cache !== undefined) dashboard.cache = body.cache;
    if (body.access !== undefined) dashboard.access = body.access;

    await dashboard.save();

    return c.json({ success: true, data: dashboard });
  } catch (error) {
    logger.error("Error updating dashboard", { error });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// PATCH /api/workspaces/:workspaceId/dashboards/:id - Partial update (widget mutations, layout changes)
app.patch("/:id", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    const body = await c.req.json();

    const existing = await Dashboard.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!existing) {
      return c.json({ success: false, error: "Dashboard not found" }, 404);
    }

    const userId = c.get("user")?.id;
    if (existing.access === "private" && existing.createdBy !== userId) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    if (existing.access === "workspace" && existing.createdBy !== userId) {
      const memberRole = c.get("memberRole");
      if (memberRole !== "owner" && memberRole !== "admin") {
        return c.json(
          {
            success: false,
            error: "Only the owner or admins can edit this dashboard",
          },
          403,
        );
      }
    }

    const dashboard = await Dashboard.findOneAndUpdate(
      {
        _id: new Types.ObjectId(id),
        workspaceId: new Types.ObjectId(workspaceId),
      },
      { $set: body },
      { new: true, runValidators: true },
    );

    return c.json({ success: true, data: dashboard });
  } catch (error) {
    logger.error("Error patching dashboard", { error });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// DELETE /api/workspaces/:workspaceId/dashboards/:id - Delete dashboard
app.delete("/:id", async c => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");

    const result = await Dashboard.deleteOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (result.deletedCount === 0) {
      return c.json({ success: false, error: "Dashboard not found" }, 404);
    }

    return c.json({ success: true, message: "Dashboard deleted successfully" });
  } catch (error) {
    logger.error("Error deleting dashboard", { error });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

// POST /api/workspaces/:workspaceId/dashboards/:id/duplicate - Duplicate dashboard
app.post("/:id/duplicate", async (c: AuthenticatedContext) => {
  try {
    const workspaceId = c.req.param("workspaceId");
    const id = c.req.param("id");
    const user = c.get("user");
    const userId = user?.id ?? "system";

    const dashboard = await Dashboard.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    });

    if (!dashboard) {
      return c.json({ success: false, error: "Dashboard not found" }, 404);
    }

    const spec: any = dashboard.toObject();
    delete spec._id;
    delete spec.__v;
    spec.title = `${spec.title} (copy)`;
    spec.createdBy = userId;

    // Regenerate all internal IDs and remap references
    const dsIdMap = new Map<string, string>();
    spec.dataSources = spec.dataSources.map((ds: any) => {
      const newId = nanoid();
      dsIdMap.set(ds.id, newId);
      return { ...ds, id: newId };
    });
    spec.widgets = spec.widgets.map((w: any) => ({
      ...w,
      id: nanoid(),
      dataSourceId: dsIdMap.get(w.dataSourceId) || w.dataSourceId,
    }));
    spec.relationships = spec.relationships.map((r: any) => ({
      ...r,
      id: nanoid(),
      from: {
        ...r.from,
        dataSourceId: dsIdMap.get(r.from.dataSourceId) || r.from.dataSourceId,
      },
      to: {
        ...r.to,
        dataSourceId: dsIdMap.get(r.to.dataSourceId) || r.to.dataSourceId,
      },
    }));
    spec.globalFilters = spec.globalFilters.map((f: any) => ({
      ...f,
      id: nanoid(),
      dataSourceId: dsIdMap.get(f.dataSourceId) || f.dataSourceId,
    }));

    const duplicate = new Dashboard(spec);
    await duplicate.save();

    return c.json({ success: true, data: duplicate });
  } catch (error) {
    logger.error("Error duplicating dashboard", { error });
    return c.json(
      {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      },
      500,
    );
  }
});

export const dashboardRoutes = app;

/**
 * Unified data-source routes for dashboard data sources and app data bindings.
 *
 * Classification: Authenticated + workspace-scoped
 * (`unifiedAuthMiddleware` + workspace verification).
 */

import { createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { workspaceService } from "../services/workspace.service";
import {
  getResourceDataSource,
  listResourceDataSources,
  refreshResourceDataSources,
  updateResourceDataSourceSettings,
} from "../services/resource-data-source.service";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";

const logger = loggers.api("resource-data-sources");
const app = createRouter();

const ResourceTypeSchema = z.enum(["dashboard", "app"]);
const ScheduleSchema = z.object({
  enabled: z.boolean(),
  cron: z.string().nullable(),
  timezone: z.string().optional(),
  dataFreshnessTtlMs: z.number().nullable().optional(),
});

const ResourceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
  resourceType: ResourceTypeSchema.openapi({
    param: { name: "resourceType", in: "path" },
  }),
  resourceId: z
    .string()
    .openapi({ param: { name: "resourceId", in: "path" } }),
});

const DataSourceParam = ResourceParam.extend({
  dataSourceId: z
    .string()
    .openapi({ param: { name: "dataSourceId", in: "path" } }),
});

const SettingsBody = {
  required: false,
  content: {
    "application/json": {
      schema: z.object({
        materialization: z.enum(["live", "parquet"]).optional(),
        schedule: ScheduleSchema.nullable().optional(),
      }),
    },
  },
};

function errorStatus(error: unknown): 400 | 403 | 404 | 500 {
  const message = error instanceof Error ? error.message : "";
  if (message === "Access denied") return 403;
  if (message.includes("not found")) return 404;
  if (message.startsWith("Invalid") || message.includes("always")) return 400;
  if (message.includes("No materialized")) return 400;
  return 500;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Request failed";
}

app.use("*", unifiedAuthMiddleware);

app.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId") as string;
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
    const member = await workspaceService.getMember(workspaceId, user.id);
    if (!member) {
      return c.json(
        { success: false, error: "Access denied to workspace" },
        403,
      );
    }
    c.set("memberRole", member.role);
  } else {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  enrichContextWithWorkspace(workspaceId);
  await next();
});

app.openapi(
  createRoute({
    method: "get",
    path: "/{resourceType}/{resourceId}",
    tags: ["Data Sources"],
    summary: "List data sources for a dashboard or app",
    security: AUTH_SECURITY,
    request: { params: ResourceParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const dataSources = await listResourceDataSources({
        workspaceId: c.req.param("workspaceId"),
        resourceType: c.req.param("resourceType") as "dashboard" | "app",
        resourceId: c.req.param("resourceId"),
        userId: c.get("user")?.id,
        memberRole: c.get("memberRole"),
      });
      return c.json({ success: true, data: { dataSources } });
    } catch (error) {
      logger.error("Error listing resource data sources", { error });
      return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
    }
  },
);

app.openapi(
  createRoute({
    method: "get",
    path: "/{resourceType}/{resourceId}/{dataSourceId}",
    tags: ["Data Sources"],
    summary: "Get one dashboard/app data source",
    security: AUTH_SECURITY,
    request: { params: DataSourceParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const dataSource = await getResourceDataSource({
        workspaceId: c.req.param("workspaceId"),
        resourceType: c.req.param("resourceType") as "dashboard" | "app",
        resourceId: c.req.param("resourceId"),
        dataSourceId: c.req.param("dataSourceId"),
        userId: c.get("user")?.id,
        memberRole: c.get("memberRole"),
      });
      return c.json({ success: true, data: { dataSource } });
    } catch (error) {
      logger.error("Error getting resource data source", { error });
      return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
    }
  },
);

app.openapi(
  createRoute({
    method: "patch",
    path: "/{resourceType}/{resourceId}/{dataSourceId}/settings",
    tags: ["Data Sources"],
    summary: "Update materialization settings for a data source",
    security: AUTH_SECURITY,
    request: { params: DataSourceParam, body: SettingsBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const body = await c.req.json().catch(() => ({}));
      const dataSource = await updateResourceDataSourceSettings({
        workspaceId: c.req.param("workspaceId"),
        resourceType: c.req.param("resourceType") as "dashboard" | "app",
        resourceId: c.req.param("resourceId"),
        dataSourceId: c.req.param("dataSourceId"),
        settings: body,
        userId: c.get("user")?.id,
        memberRole: c.get("memberRole"),
      });
      return c.json({ success: true, data: { dataSource } });
    } catch (error) {
      logger.error("Error updating resource data source settings", { error });
      return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
    }
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/{resourceType}/{resourceId}/refresh",
    tags: ["Data Sources"],
    summary: "Refresh all materialized data sources for a dashboard or app",
    security: AUTH_SECURITY,
    request: { params: ResourceParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const result = await refreshResourceDataSources({
        workspaceId: c.req.param("workspaceId"),
        resourceType: c.req.param("resourceType") as "dashboard" | "app",
        resourceId: c.req.param("resourceId"),
        userId: c.get("user")?.id,
        memberRole: c.get("memberRole"),
      });
      return c.json({ success: true, data: result });
    } catch (error) {
      logger.error("Error refreshing resource data sources", { error });
      return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
    }
  },
);

app.openapi(
  createRoute({
    method: "post",
    path: "/{resourceType}/{resourceId}/{dataSourceId}/refresh",
    tags: ["Data Sources"],
    summary: "Refresh one materialized data source for a dashboard or app",
    security: AUTH_SECURITY,
    request: { params: DataSourceParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const result = await refreshResourceDataSources({
        workspaceId: c.req.param("workspaceId"),
        resourceType: c.req.param("resourceType") as "dashboard" | "app",
        resourceId: c.req.param("resourceId"),
        dataSourceId: c.req.param("dataSourceId"),
        userId: c.get("user")?.id,
        memberRole: c.get("memberRole"),
      });
      return c.json({ success: true, data: result });
    } catch (error) {
      logger.error("Error refreshing resource data source", { error });
      return c.json({ success: false, error: errorMessage(error) }, errorStatus(error));
    }
  },
);

export const resourceDataSourceRoutes = app;

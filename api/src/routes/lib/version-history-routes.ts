import { OpenAPIHono, createRoute, z } from "@hono/zod-openapi";
import { Types } from "mongoose";

import { loggers } from "../../logging";
import type { VersionableEntityType } from "../../database/workspace-schema";
import type { AuthenticatedContext } from "../../middleware/workspace.middleware";
import {
  createVersion,
  getUserDisplayName,
  getVersion,
  listVersions,
} from "../../services/entity-version.service";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  pathParam,
  type AuthEnv,
} from "../../openapi/core";

const logger = loggers.api("version-history");

type MaybePromise<T> = T | Promise<T>;
type AccessResult = true | { status?: 401 | 403; error: string };

interface RestoreRouteResult {
  snapshot: Record<string, unknown>;
  response: Record<string, unknown>;
}

export interface VersionHistoryRouteOptions<TResource> {
  resourceName: string;
  tag: string;
  entityType: VersionableEntityType;
  load: (
    c: AuthenticatedContext,
    ids: { workspaceId: string; resourceId: string },
  ) => Promise<TResource | null>;
  canRead?: (
    c: AuthenticatedContext,
    resource: TResource,
    userId: string,
  ) => MaybePromise<AccessResult>;
  canWrite: (
    c: AuthenticatedContext,
    resource: TResource,
    userId: string,
  ) => MaybePromise<AccessResult>;
  restore: (params: {
    c: AuthenticatedContext;
    resource: TResource;
    workspaceId: string;
    resourceId: string;
    version: number;
    snapshot: Record<string, unknown>;
    comment?: unknown;
  }) => Promise<RestoreRouteResult | null>;
}

const VersionIdParam = z.object({
  workspaceId: pathParam("workspaceId"),
  id: pathParam("id"),
});
const VersionNumberParam = VersionIdParam.extend({
  version: pathParam("version"),
});
const VersionQuery = z.object({
  limit: z.string().optional().openapi({ param: { name: "limit", in: "query" } }),
  offset: z
    .string()
    .optional()
    .openapi({ param: { name: "offset", in: "query" } }),
});
const RestoreBody = {
  required: false,
  content: {
    "application/json": {
      schema: z.record(z.string(), z.any()),
    },
  },
};

function titleCase(value: string): string {
  return value.slice(0, 1).toUpperCase() + value.slice(1);
}

function parsePage(value: string | undefined, fallback: number): number {
  return parseInt(value ?? String(fallback), 10) || fallback;
}

function accessDenied(result: AccessResult) {
  if (result === true) return null;
  return {
    status: result.status ?? 403,
    error: result.error,
  };
}

export function registerVersionHistoryRoutes<TResource>(
  app: OpenAPIHono<AuthEnv>,
  options: VersionHistoryRouteOptions<TResource>,
): void {
  const resourceTitle = titleCase(options.resourceName);

  app.openapi(
    createRoute({
      method: "get",
      path: "/{id}/versions",
      tags: [options.tag],
      summary: `List ${options.resourceName} versions`,
      security: AUTH_SECURITY,
      request: {
        params: VersionIdParam,
        query: VersionQuery,
      },
      responses: { ...OPEN_RESPONSES },
    }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const resourceId = c.req.param("id") as string;
        const userId = c.get("user")?.id;

        if (!userId) {
          return c.json({ success: false, error: "Unauthorized" }, 401);
        }
        if (!Types.ObjectId.isValid(resourceId)) {
          return c.json(
            { success: false, error: `Invalid ${options.resourceName} ID` },
            400,
          );
        }

        const resource = await options.load(c, { workspaceId, resourceId });
        if (!resource) {
          return c.json(
            { success: false, error: `${resourceTitle} not found` },
            404,
          );
        }

        const readAccess = options.canRead
          ? await options.canRead(c, resource, userId)
          : true;
        const denial = accessDenied(readAccess);
        if (denial) {
          return c.json({ success: false, error: denial.error }, denial.status);
        }

        const limit = Math.min(parsePage(c.req.query("limit"), 50), 100);
        const offset = parsePage(c.req.query("offset"), 0);
        const result = await listVersions(
          new Types.ObjectId(resourceId),
          options.entityType,
          { limit, offset },
        );

        return c.json({ success: true, ...result });
      } catch (error) {
        logger.error(`Error listing ${options.resourceName} versions`, {
          error,
        });
        return c.json({ success: false, error: "Failed to list versions" }, 500);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "get",
      path: "/{id}/versions/{version}",
      tags: [options.tag],
      summary: `Get ${options.resourceName} version`,
      security: AUTH_SECURITY,
      request: {
        params: VersionNumberParam,
      },
      responses: { ...OPEN_RESPONSES },
    }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const resourceId = c.req.param("id") as string;
        const versionNum = parseInt(c.req.param("version"), 10);
        const userId = c.get("user")?.id;

        if (!userId) {
          return c.json({ success: false, error: "Unauthorized" }, 401);
        }
        if (!Types.ObjectId.isValid(resourceId) || isNaN(versionNum)) {
          return c.json(
            {
              success: false,
              error: `Invalid ${options.resourceName} ID or version`,
            },
            400,
          );
        }

        const resource = await options.load(c, { workspaceId, resourceId });
        if (!resource) {
          return c.json(
            { success: false, error: `${resourceTitle} not found` },
            404,
          );
        }

        const readAccess = options.canRead
          ? await options.canRead(c, resource, userId)
          : true;
        const denial = accessDenied(readAccess);
        if (denial) {
          return c.json({ success: false, error: denial.error }, denial.status);
        }

        const version = await getVersion(
          resourceId,
          options.entityType,
          versionNum,
        );
        if (!version) {
          return c.json({ success: false, error: "Version not found" }, 404);
        }

        return c.json({ success: true, version });
      } catch (error) {
        logger.error(`Error getting ${options.resourceName} version`, {
          error,
        });
        return c.json({ success: false, error: "Failed to get version" }, 500);
      }
    },
  );

  app.openapi(
    createRoute({
      method: "post",
      path: "/{id}/versions/{version}/restore",
      tags: [options.tag],
      summary: `Restore ${options.resourceName} version`,
      security: AUTH_SECURITY,
      request: {
        params: VersionNumberParam,
        body: RestoreBody,
      },
      responses: { ...OPEN_RESPONSES },
    }),
    async c => {
      try {
        const workspaceId = c.req.param("workspaceId") as string;
        const resourceId = c.req.param("id") as string;
        const versionNum = parseInt(c.req.param("version"), 10);
        const body = await c.req.json().catch(() => ({}));
        const userId = c.get("user")?.id;

        if (!userId) {
          return c.json({ success: false, error: "Unauthorized" }, 401);
        }
        if (!Types.ObjectId.isValid(resourceId) || isNaN(versionNum)) {
          return c.json(
            {
              success: false,
              error: `Invalid ${options.resourceName} ID or version`,
            },
            400,
          );
        }

        const resource = await options.load(c, { workspaceId, resourceId });
        if (!resource) {
          return c.json(
            { success: false, error: `${resourceTitle} not found` },
            404,
          );
        }

        const writeAccess = await options.canWrite(c, resource, userId);
        const denial = accessDenied(writeAccess);
        if (denial) {
          return c.json({ success: false, error: denial.error }, denial.status);
        }

        const oldVersion = await getVersion(
          resourceId,
          options.entityType,
          versionNum,
        );
        if (!oldVersion) {
          return c.json({ success: false, error: "Version not found" }, 404);
        }

        const result = await options.restore({
          c,
          resource,
          workspaceId,
          resourceId,
          version: versionNum,
          snapshot: oldVersion.snapshot as Record<string, unknown>,
          comment: (body as { comment?: unknown }).comment,
        });
        if (!result) {
          return c.json({ success: false, error: "Restore failed" }, 500);
        }

        const displayName = await getUserDisplayName(userId);
        await createVersion({
          entityType: options.entityType,
          entityId: new Types.ObjectId(resourceId),
          workspaceId: new Types.ObjectId(workspaceId),
          snapshot: result.snapshot,
          savedBy: userId,
          savedByName: displayName,
          comment:
            typeof (body as { comment?: unknown }).comment === "string"
              ? (body as { comment: string }).comment
              : `Restored from version ${versionNum}`,
          restoredFrom: versionNum,
        });

        return c.json(result.response);
      } catch (error) {
        logger.error(`Error restoring ${options.resourceName} version`, {
          error,
        });
        return c.json(
          { success: false, error: "Failed to restore version" },
          500,
        );
      }
    },
  );
}

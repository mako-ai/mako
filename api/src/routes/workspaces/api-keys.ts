/** Workspace-scoped API keys: list, create, revoke. */
import { createRoute } from "@hono/zod-openapi";
import {
  isSessionAuth,
  unifiedAuthMiddleware,
} from "../../auth/unified-auth.middleware";
import {
  parseWorkspaceApiKeyScopes,
  resolveWorkspaceApiKeyScopes,
  type WorkspaceApiKeyScope,
} from "../../auth/api-key-scopes";
import {
  requireWorkspace,
  requireWorkspaceRole,
} from "../../middleware/workspace.middleware";
import { Workspace } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { IdParam, IdKeyParam, JsonBody } from "./schemas";
import { fail, failFromThrown } from "../lib/respond";

const logger = loggers.workspace();

export const workspaceApiKeyRoutes = createRouter();

// GET /api/workspaces/:id/api-keys - List API keys
workspaceApiKeyRoutes.openapi(
  createRoute({
    method: "get",
    path: "/{id}/api-keys",
    tags: ["Workspaces"],
    summary: "List workspace API keys",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: { params: IdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      if (!isSessionAuth(c)) {
        return fail(c, 403, "API key management requires a browser session");
      }
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");

      if (workspaceId !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
      }

      // Return API keys without the hash
      const apiKeys =
        workspace.apiKeys?.map((key: any) => ({
          id: key._id,
          name: key.name,
          prefix: key.prefix,
          createdAt: key.createdAt,
          lastUsedAt: key.lastUsedAt,
          createdBy: key.createdBy,
          scopes: resolveWorkspaceApiKeyScopes(key.scopes),
        })) || [];

      return c.json({
        success: true,
        apiKeys,
      });
    } catch (error) {
      logger.error("Error listing API keys", { error });
      return failFromThrown(c, error, "Failed to list API keys");
    }
  },
);

// POST /api/workspaces/:id/api-keys - Create new API key
workspaceApiKeyRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/api-keys",
    tags: ["Workspaces"],
    summary: "Create a workspace API key",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: { params: IdParam, body: JsonBody },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      if (!isSessionAuth(c)) {
        return fail(c, 403, "API key management requires a browser session");
      }
      const workspace = c.get("workspace");
      const user = c.get("user");
      const workspaceId = c.req.param("id");
      const body = await c.req.json();
      const { name, scopes: rawScopes } = body;

      if (workspaceId !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
      }

      if (!name || typeof name !== "string" || name.trim().length === 0) {
        return fail(c, 400, "API key name is required");
      }

      if (!user) {
        return fail(c, 401, "Unauthorized");
      }

      let scopes: WorkspaceApiKeyScope[];
      try {
        scopes = parseWorkspaceApiKeyScopes(rawScopes);
      } catch (error) {
        return fail(
          c,
          400,
          error instanceof Error ? error.message : "Invalid API key scopes",
        );
      }

      // Import the generateApiKey function
      const { generateApiKey } = await import("../../auth/api-key.middleware");

      // Generate new API key
      const { key, hash, prefix } = generateApiKey();

      // Add API key to workspace
      const newApiKey = {
        name: name.trim(),
        keyHash: hash,
        prefix,
        scopes,
        createdAt: new Date(),
        createdBy: user.id,
      };

      const updatedWorkspace = await Workspace.findByIdAndUpdate(
        workspace._id,
        {
          $push: { apiKeys: newApiKey },
        },
        { returnDocument: "after" },
      );

      // Find the newly created API key
      const createdKey = updatedWorkspace?.apiKeys?.slice(-1)[0];

      return c.json({
        success: true,
        apiKey: {
          id: createdKey?._id,
          name: createdKey?.name,
          prefix: createdKey?.prefix,
          createdAt: createdKey?.createdAt,
          scopes: resolveWorkspaceApiKeyScopes(createdKey?.scopes),
        },
        key, // Only return the full key once, during creation
        message:
          "API key created successfully. Store this key securely - it won't be shown again.",
      });
    } catch (error) {
      logger.error("Error creating API key", { error });
      return failFromThrown(c, error, "Failed to create API key");
    }
  },
);

// DELETE /api/workspaces/:id/api-keys/:keyId - Delete API key
workspaceApiKeyRoutes.openapi(
  createRoute({
    method: "delete",
    path: "/{id}/api-keys/{keyId}",
    tags: ["Workspaces"],
    summary: "Delete a workspace API key",
    security: AUTH_SECURITY,
    middleware: [
      unifiedAuthMiddleware,
      requireWorkspace,
      requireWorkspaceRole(["owner", "admin"]),
    ] as const,
    request: { params: IdKeyParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      if (!isSessionAuth(c)) {
        return fail(c, 403, "API key management requires a browser session");
      }
      const workspace = c.get("workspace");
      const workspaceId = c.req.param("id");
      const keyId = c.req.param("keyId");

      if (workspaceId !== workspace._id.toString()) {
        return fail(c, 400, "Workspace ID mismatch");
      }

      // Remove API key from workspace
      const updatedWorkspace = await Workspace.findByIdAndUpdate(
        workspace._id,
        {
          $pull: { apiKeys: { _id: keyId } },
        },
        { returnDocument: "after" },
      );

      if (!updatedWorkspace) {
        return fail(c, 404, "Workspace not found");
      }

      return c.json({
        success: true,
        message: "API key deleted successfully",
      });
    } catch (error) {
      logger.error("Error deleting API key", { error });
      return failFromThrown(c, error, "Failed to delete API key");
    }
  },
);

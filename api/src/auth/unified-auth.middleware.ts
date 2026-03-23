import { Context, Next } from "hono";
import { sessionManager } from "./session";
import { getCookie } from "hono/cookie";
import { hashApiKey } from "./api-key.middleware";
import { Workspace } from "../database/workspace-schema";
import { User } from "../database/schema";
import {
  loggers,
  enrichContextWithUser,
  enrichContextWithWorkspace,
} from "../logging";

const logger = loggers.auth();

/**
 * Unified authentication middleware that supports both session and API key authentication
 */
export async function unifiedAuthMiddleware(c: Context, next: Next) {
  // Check for API key first (Bearer token)
  const authHeader = c.req.header("Authorization");

  if (authHeader && authHeader.startsWith("Bearer ")) {
    const apiKey = authHeader.substring(7);

    if (apiKey.startsWith("revops_")) {
      try {
        // Hash the provided key
        const keyHash = hashApiKey(apiKey);

        // Find workspace with this API key
        const workspace = await Workspace.findOne({
          "apiKeys.keyHash": keyHash,
        });

        if (workspace) {
          const workspaceApiKey = workspace.apiKeys?.find(
            k => k.keyHash === keyHash,
          );
          if (!workspaceApiKey?.createdBy) {
            logger.warn("API key is missing creator metadata", {
              workspaceId: workspace._id.toString(),
            });
            return c.json({ error: "Invalid API key" }, 401);
          }

          const creator = await User.findById(workspaceApiKey.createdBy).lean();
          if (!creator) {
            logger.warn("API key creator not found", {
              workspaceId: workspace._id.toString(),
              createdBy: workspaceApiKey.createdBy,
            });
            return c.json({ error: "Invalid API key owner" }, 401);
          }

          // Update last used timestamp
          await Workspace.updateOne(
            {
              _id: workspace._id,
              "apiKeys.keyHash": keyHash,
            },
            {
              $set: {
                "apiKeys.$.lastUsedAt": new Date(),
              },
            },
          );

          // API keys are workspace-scoped, but they also act on behalf of
          // the user who created them so private resources remain visible.
          c.set("user", {
            id: creator._id,
            email: creator.email,
          });
          c.set("workspace", workspace);
          c.set("apiKey", workspaceApiKey);
          c.set("authType", "apiKey");
          c.set("workspaceId", workspace._id.toString());

          enrichContextWithUser(creator._id);
          // Enrich logging context with workspace ID (API key auth)
          enrichContextWithWorkspace(workspace._id.toString());

          await next();
          return;
        }
      } catch (error) {
        logger.error("API key authentication error", { error });
      }
    }
  }

  // Fall back to session authentication
  const sessionId = getCookie(c, sessionManager.sessionCookieName);

  if (!sessionId) {
    return c.json({ error: "Unauthorized" }, 401);
  }

  const { session, user } = await sessionManager.validateSession(sessionId);

  if (!session || !user) {
    return c.json({ error: "Invalid session" }, 401);
  }

  // Store user and auth type in context
  c.set("user", user);
  c.set("session", session);
  c.set("authType", "session");

  // Enrich logging context with user ID (session auth)
  enrichContextWithUser(user.id);

  await next();
}

/**
 * Check if the request is authenticated via API key
 */
export function isApiKeyAuth(c: Context): boolean {
  return c.get("authType") === "apiKey";
}

/**
 * Check if the request is authenticated via session
 */
export function isSessionAuth(c: Context): boolean {
  return c.get("authType") === "session";
}

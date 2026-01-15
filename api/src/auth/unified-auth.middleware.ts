import { Context, Next } from "hono";
import { sessionManager } from "./session";
import { getCookie } from "hono/cookie";
import { hashApiKey } from "./api-key.middleware";
import { Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";

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

          // Store workspace and auth type in context
          c.set("workspace", workspace);
          c.set(
            "apiKey",
            workspace.apiKeys?.find(k => k.keyHash === keyHash),
          );
          c.set("authType", "apiKey");
          c.set("workspaceId", workspace._id.toString());

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

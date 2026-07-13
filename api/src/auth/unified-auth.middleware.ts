import { Context, Next } from "hono";
import { sessionManager, writeSessionCookie } from "./session";
import { getCookie } from "hono/cookie";
import { hashApiKey } from "./api-key.middleware";
import {
  MCP_ACCESS_TOKEN_PREFIX,
  validateMcpAccessToken,
} from "./mcp-oauth.service";
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

    // OAuth access tokens minted by the MCP sign-in flow. Like scoped API
    // keys they are valid only on the MCP endpoint — never the REST surface.
    if (apiKey.startsWith(MCP_ACCESS_TOKEN_PREFIX)) {
      try {
        if (!/^\/api\/mcp\/?$/.test(c.req.path)) {
          return c.json(
            {
              error: "MCP OAuth tokens are restricted to the /api/mcp endpoint",
            },
            403,
          );
        }
        const validated = await validateMcpAccessToken(apiKey);
        if (!validated) {
          return c.json({ error: "Invalid or expired MCP access token" }, 401);
        }
        const [tokenUser, workspace] = await Promise.all([
          User.findById(validated.userId).lean(),
          Workspace.findById(validated.workspaceId),
        ]);
        if (!tokenUser || !workspace) {
          return c.json({ error: "Invalid MCP access token" }, 401);
        }

        c.set("user", { id: tokenUser._id, email: tokenUser.email });
        c.set("workspace", workspace);
        c.set("authType", "mcpOAuth");
        c.set("workspaceId", workspace._id.toString());
        c.set("mcpOAuthScopes", validated.scopes);

        enrichContextWithUser(tokenUser._id);
        enrichContextWithWorkspace(workspace._id.toString());

        await next();
        return;
      } catch (error) {
        logger.error("MCP OAuth token authentication error", { error });
        return c.json({ error: "Authentication failed" }, 500);
      }
    }

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
          if (
            workspaceApiKey.scopes !== undefined &&
            !/^\/api\/mcp\/?$/.test(c.req.path)
          ) {
            return c.json(
              {
                error:
                  "This scoped API key is restricted to the Mako MCP endpoint",
              },
              403,
            );
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

  // Slide the browser cookie whenever the session was refreshed so it tracks
  // the DB expiry instead of hard-expiring at the original login time.
  if (session.fresh) {
    writeSessionCookie(c, session.id);
  }

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
 * Check if the request is authenticated via an MCP OAuth access token
 */
export function isMcpOAuthAuth(c: Context): boolean {
  return c.get("authType") === "mcpOAuth";
}

/**
 * Check if the request is authenticated via session
 */
export function isSessionAuth(c: Context): boolean {
  return c.get("authType") === "session";
}

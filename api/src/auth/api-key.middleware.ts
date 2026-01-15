import { Context, Next } from "hono";
import * as crypto from "crypto";
import { Workspace } from "../database/workspace-schema";
import { loggers } from "../logging";

const logger = loggers.auth();

/**
 * Generate a new API key
 * Returns the full key (only shown once) and the hash to store
 */
export function generateApiKey(): {
  key: string;
  hash: string;
  prefix: string;
} {
  // Generate a random 32-byte key
  const keyBytes = crypto.randomBytes(32);
  const key = `revops_${keyBytes.toString("base64url")}`;

  // Create hash for storage
  const hash = crypto.createHash("sha256").update(key).digest("hex");

  // Extract prefix for identification (first 8 chars after "revops_")
  const prefix = key.substring(0, 14); // "revops_" + first 8 chars

  return { key, hash, prefix };
}

/**
 * Hash an API key for comparison
 */
export function hashApiKey(key: string): string {
  return crypto.createHash("sha256").update(key).digest("hex");
}

/**
 * API Key authentication middleware
 */
export async function apiKeyAuthMiddleware(c: Context, next: Next) {
  const authHeader = c.req.header("Authorization");

  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const apiKey = authHeader.substring(7); // Remove "Bearer " prefix

  if (!apiKey.startsWith("revops_")) {
    return c.json({ error: "Invalid API key format" }, 401);
  }

  try {
    // Hash the provided key
    const keyHash = hashApiKey(apiKey);

    // Find workspace with this API key
    const workspace = await Workspace.findOne({
      "apiKeys.keyHash": keyHash,
    });

    if (!workspace) {
      return c.json({ error: "Invalid API key" }, 401);
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

    // Store workspace in context for route handlers
    c.set("workspace", workspace);
    c.set(
      "apiKey",
      workspace.apiKeys?.find(k => k.keyHash === keyHash),
    );

    await next();
  } catch (error) {
    logger.error("API key authentication error", { error });
    return c.json({ error: "Authentication failed" }, 500);
  }
}

/**
 * Context type for routes using API key authentication
 */
export interface ApiKeyAuthenticatedContext extends Context {
  Variables: {
    workspace: any; // IWorkspace type
    apiKey: any; // IWorkspaceApiKey type
  };
}

/**
 * Usage Analytics Routes
 *
 * Workspace-scoped endpoints for querying LLM token usage and cost.
 * Mounted at /api/workspaces/:workspaceId/usage
 */

import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { workspaceService } from "../services/workspace.service";
import { LlmUsage } from "../database/schema";
import { loggers, enrichContextWithWorkspace } from "../logging";

const logger = loggers.api("usage");

export const usageRoutes = new Hono();

usageRoutes.use("*", unifiedAuthMiddleware);

// Workspace access verification middleware
usageRoutes.use("*", async (c: AuthenticatedContext, next) => {
  const workspaceId = c.req.param("workspaceId");
  if (!workspaceId) return c.json({ error: "Missing workspaceId" }, 400);

  const user = c.get("user");
  const workspace = c.get("workspace");

  if (workspace) {
    if (workspace._id.toString() !== workspaceId) {
      return c.json(
        { error: "API key not authorized for this workspace" },
        403,
      );
    }
  } else if (user) {
    const hasAccess = await workspaceService.hasAccess(workspaceId, user.id);
    if (!hasAccess) {
      return c.json({ error: "Access denied" }, 403);
    }
  } else {
    return c.json({ error: "Unauthorized" }, 401);
  }

  enrichContextWithWorkspace(workspaceId);
  await next();
});

function parseDateRange(c: AuthenticatedContext) {
  const from = c.req.query("from");
  const to = c.req.query("to");
  const match: Record<string, unknown> = {};
  if (from || to) {
    const dateFilter: Record<string, Date> = {};
    if (from) dateFilter.$gte = new Date(from);
    if (to) dateFilter.$lte = new Date(to);
    match.createdAt = dateFilter;
  }
  return match;
}

/**
 * GET /summary -- total tokens + cost for the workspace
 * Query params: ?from=ISO&to=ISO
 */
usageRoutes.get("/summary", async (c: AuthenticatedContext) => {
  const workspaceId = c.req.param("workspaceId")!;
  const dateFilter = parseDateRange(c);

  try {
    const [result] = await LlmUsage.aggregate([
      {
        $match: {
          workspaceId: new ObjectId(workspaceId),
          ...dateFilter,
        },
      },
      {
        $group: {
          _id: null,
          totalInputTokens: { $sum: "$inputTokens" },
          totalOutputTokens: { $sum: "$outputTokens" },
          totalCacheReadTokens: { $sum: "$cacheReadTokens" },
          totalCacheWriteTokens: { $sum: "$cacheWriteTokens" },
          totalReasoningTokens: { $sum: "$reasoningTokens" },
          totalTokens: { $sum: "$totalTokens" },
          totalCostUsd: { $sum: "$costUsd" },
          invocationCount: { $sum: 1 },
        },
      },
      { $project: { _id: 0 } },
    ]);

    return c.json(
      result ?? {
        totalInputTokens: 0,
        totalOutputTokens: 0,
        totalCacheReadTokens: 0,
        totalCacheWriteTokens: 0,
        totalReasoningTokens: 0,
        totalTokens: 0,
        totalCostUsd: 0,
        invocationCount: 0,
      },
    );
  } catch (err) {
    logger.error("Error fetching usage summary", { error: err });
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * GET /by-user -- breakdown per user
 * Query params: ?from=ISO&to=ISO
 */
usageRoutes.get("/by-user", async (c: AuthenticatedContext) => {
  const workspaceId = c.req.param("workspaceId")!;
  const dateFilter = parseDateRange(c);

  try {
    const results = await LlmUsage.aggregate([
      {
        $match: {
          workspaceId: new ObjectId(workspaceId),
          ...dateFilter,
        },
      },
      {
        $group: {
          _id: "$userId",
          totalInputTokens: { $sum: "$inputTokens" },
          totalOutputTokens: { $sum: "$outputTokens" },
          totalCacheReadTokens: { $sum: "$cacheReadTokens" },
          totalTokens: { $sum: "$totalTokens" },
          totalCostUsd: { $sum: "$costUsd" },
          invocationCount: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          userId: "$_id",
          totalInputTokens: 1,
          totalOutputTokens: 1,
          totalCacheReadTokens: 1,
          totalTokens: 1,
          totalCostUsd: 1,
          invocationCount: 1,
        },
      },
      { $sort: { totalCostUsd: -1 } },
    ]);

    return c.json({ users: results });
  } catch (err) {
    logger.error("Error fetching usage by user", { error: err });
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * GET /by-chat/:chatId -- per-chat detail
 */
usageRoutes.get("/by-chat/:chatId", async (c: AuthenticatedContext) => {
  const workspaceId = c.req.param("workspaceId")!;
  const chatId = c.req.param("chatId")!;

  if (!ObjectId.isValid(chatId)) {
    return c.json({ error: "Invalid chatId" }, 400);
  }

  try {
    const results = await LlmUsage.find({
      workspaceId: new ObjectId(workspaceId),
      chatId: new ObjectId(chatId),
    })
      .sort({ createdAt: 1 })
      .lean();

    const totals = results.reduce(
      (acc, r) => {
        acc.inputTokens += r.inputTokens;
        acc.outputTokens += r.outputTokens;
        acc.cacheReadTokens += r.cacheReadTokens;
        acc.totalTokens += r.totalTokens;
        acc.costUsd += r.costUsd;
        return acc;
      },
      {
        inputTokens: 0,
        outputTokens: 0,
        cacheReadTokens: 0,
        totalTokens: 0,
        costUsd: 0,
      },
    );

    return c.json({
      chatId,
      totals,
      invocations: results,
    });
  } catch (err) {
    logger.error("Error fetching usage by chat", { error: err });
    return c.json({ error: "Internal server error" }, 500);
  }
});

/**
 * GET /by-model -- breakdown per model
 * Query params: ?from=ISO&to=ISO
 */
usageRoutes.get("/by-model", async (c: AuthenticatedContext) => {
  const workspaceId = c.req.param("workspaceId")!;
  const dateFilter = parseDateRange(c);

  try {
    const results = await LlmUsage.aggregate([
      {
        $match: {
          workspaceId: new ObjectId(workspaceId),
          ...dateFilter,
        },
      },
      {
        $group: {
          _id: "$modelId",
          totalInputTokens: { $sum: "$inputTokens" },
          totalOutputTokens: { $sum: "$outputTokens" },
          totalCacheReadTokens: { $sum: "$cacheReadTokens" },
          totalTokens: { $sum: "$totalTokens" },
          totalCostUsd: { $sum: "$costUsd" },
          invocationCount: { $sum: 1 },
        },
      },
      {
        $project: {
          _id: 0,
          modelId: "$_id",
          totalInputTokens: 1,
          totalOutputTokens: 1,
          totalCacheReadTokens: 1,
          totalTokens: 1,
          totalCostUsd: 1,
          invocationCount: 1,
        },
      },
      { $sort: { totalCostUsd: -1 } },
    ]);

    return c.json({ models: results });
  } catch (err) {
    logger.error("Error fetching usage by model", { error: err });
    return c.json({ error: "Internal server error" }, 500);
  }
});

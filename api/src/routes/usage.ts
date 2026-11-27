/**
 * Usage Analytics Routes
 *
 * Workspace-scoped endpoints for querying LLM token usage and cost.
 * Mounted at /api/workspaces/:workspaceId/usage
 */

import { createRoute, z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { parseEntityId } from "../database/pg/id-codec";
import { loggers } from "../logging";
import {
  AUTH_SECURITY,
  STD_ERRORS,
  createRouter,
  jsonContent,
  pathParam,
  queryParam,
} from "../openapi/core";
import {
  usageStatsRepo,
  type DateRangeFilter,
} from "../repositories/usage-stats";
import { fail } from "./lib/respond";
import { requireWorkspaceAccess } from "./lib/workspace-access";

const logger = loggers.api("usage");

export const usageRoutes = createRouter();

const WorkspaceParam = z.object({ workspaceId: pathParam("workspaceId") });

const DateRangeQuery = z.object({
  from: queryParam("from"),
  to: queryParam("to"),
});

const UsageTotalsSchema = z
  .object({
    totalInputTokens: z.number(),
    totalOutputTokens: z.number(),
    totalCacheReadTokens: z.number(),
    totalCacheWriteTokens: z.number(),
    totalReasoningTokens: z.number(),
    totalTokens: z.number(),
    totalCostUsd: z.number(),
    invocationCount: z.number(),
  })
  .openapi("UsageTotals");

const UsageByUserSchema = UsageTotalsSchema.extend({
  userId: z.string().nullable(),
}).openapi("UsageByUser");

const UsageByModelSchema = UsageTotalsSchema.extend({
  modelId: z.string().nullable(),
}).openapi("UsageByModel");

const ChatInvocationTotalsSchema = z.object({
  inputTokens: z.number(),
  outputTokens: z.number(),
  cacheReadTokens: z.number(),
  cacheWriteTokens: z.number(),
  reasoningTokens: z.number(),
  totalTokens: z.number(),
  costUsd: z.number(),
});

usageRoutes.use("*", unifiedAuthMiddleware);

// Workspace access verification middleware
usageRoutes.use(
  "*",
  requireWorkspaceAccess({
    whenMissing: "reject",
    deniedMessage: "Access denied",
  }),
);

function parseDateRange(
  c: Context,
): { ok: true; range: DateRangeFilter } | { ok: false; error: string } {
  const from = c.req.query("from");
  const to = c.req.query("to");
  const range: DateRangeFilter = {};
  if (from) {
    const d = new Date(from);
    if (isNaN(d.getTime())) {
      return { ok: false, error: "Invalid 'from' date" };
    }
    range.from = d;
  }
  if (to) {
    const d = new Date(to);
    if (isNaN(d.getTime())) return { ok: false, error: "Invalid 'to' date" };
    range.to = d;
  }
  return { ok: true, range };
}

usageRoutes.openapi(
  createRoute({
    method: "get",
    path: "/summary",
    tags: ["Usage"],
    summary: "Workspace usage summary",
    description:
      "Total tokens and cost for the workspace, optionally date-filtered.",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam, query: DateRangeQuery },
    responses: {
      200: jsonContent(UsageTotalsSchema, "Aggregate usage totals."),
      ...STD_ERRORS,
    },
  }),
  async c => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return fail(c, 400, "Missing workspaceId");
    const parsed = parseDateRange(c);
    if (!parsed.ok) return fail(c, 400, parsed.error);

    try {
      const result = await usageStatsRepo.getWorkspaceLlmUsageSummary(
        workspaceId,
        parsed.range,
      );
      return c.json(result, 200);
    } catch (err) {
      logger.error("Error fetching usage summary", { error: err });
      return fail(c, 500, "Internal server error");
    }
  },
);

usageRoutes.openapi(
  createRoute({
    method: "get",
    path: "/by-user",
    tags: ["Usage"],
    summary: "Usage breakdown by user",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam, query: DateRangeQuery },
    responses: {
      200: jsonContent(
        z.object({ users: z.array(UsageByUserSchema) }),
        "Per-user usage breakdown.",
      ),
      ...STD_ERRORS,
    },
  }),
  async c => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return fail(c, 400, "Missing workspaceId");
    const parsed = parseDateRange(c);
    if (!parsed.ok) return fail(c, 400, parsed.error);

    try {
      const results = await usageStatsRepo.getWorkspaceLlmUsageByUser(
        workspaceId,
        parsed.range,
      );
      return c.json({ users: results }, 200);
    } catch (err) {
      logger.error("Error fetching usage by user", { error: err });
      return fail(c, 500, "Internal server error");
    }
  },
);

usageRoutes.openapi(
  createRoute({
    method: "get",
    path: "/by-chat/{chatId}",
    tags: ["Usage"],
    summary: "Usage detail for a chat",
    security: AUTH_SECURITY,
    request: {
      params: WorkspaceParam.extend({ chatId: pathParam("chatId") }),
    },
    responses: {
      200: jsonContent(
        z.object({
          chatId: z.string(),
          totals: ChatInvocationTotalsSchema,
          invocations: z.array(z.record(z.string(), z.any())),
        }),
        "Per-chat usage detail.",
      ),
      ...STD_ERRORS,
    },
  }),
  async c => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return fail(c, 400, "Missing workspaceId");
    const chatId = c.req.param("chatId");
    if (!chatId || !parseEntityId(chatId)) {
      return fail(c, 400, "Invalid chatId");
    }

    try {
      const results = await usageStatsRepo.listLlmUsageByChat(
        workspaceId,
        chatId,
      );

      const totals = results.reduce(
        (acc, r) => {
          acc.inputTokens += r.inputTokens;
          acc.outputTokens += r.outputTokens;
          acc.cacheReadTokens += r.cacheReadTokens;
          acc.cacheWriteTokens += r.cacheWriteTokens;
          acc.reasoningTokens += r.reasoningTokens;
          acc.totalTokens += r.totalTokens;
          acc.costUsd += r.costUsd;
          return acc;
        },
        {
          inputTokens: 0,
          outputTokens: 0,
          cacheReadTokens: 0,
          cacheWriteTokens: 0,
          reasoningTokens: 0,
          totalTokens: 0,
          costUsd: 0,
        },
      );

      return c.json(
        {
          chatId,
          totals,
          invocations: results,
        },
        200,
      );
    } catch (err) {
      logger.error("Error fetching usage by chat", { error: err });
      return fail(c, 500, "Internal server error");
    }
  },
);

usageRoutes.openapi(
  createRoute({
    method: "get",
    path: "/by-model",
    tags: ["Usage"],
    summary: "Usage breakdown by model",
    security: AUTH_SECURITY,
    request: { params: WorkspaceParam, query: DateRangeQuery },
    responses: {
      200: jsonContent(
        z.object({ models: z.array(UsageByModelSchema) }),
        "Per-model usage breakdown.",
      ),
      ...STD_ERRORS,
    },
  }),
  async c => {
    const workspaceId = c.req.param("workspaceId");
    if (!workspaceId) return fail(c, 400, "Missing workspaceId");
    const parsed = parseDateRange(c);
    if (!parsed.ok) return fail(c, 400, parsed.error);

    try {
      const results = await usageStatsRepo.getWorkspaceLlmUsageByModel(
        workspaceId,
        parsed.range,
      );
      return c.json({ models: results }, 200);
    } catch (err) {
      logger.error("Error fetching usage by model", { error: err });
      return fail(c, 500, "Internal server error");
    }
  },
);

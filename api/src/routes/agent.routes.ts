/**
 * Agent Routes
 * Native Vercel AI SDK streaming protocol for useChat compatibility.
 * The chat turn itself is a pipeline in services/agent-chat/; this file is
 * the HTTP spec + the mapping of each step's outcome onto a response.
 */

import { createRoute, z } from "@hono/zod-openapi";
import { ObjectId } from "mongodb";
import { sanitizeToolFailureMessage } from "../agent-lib/tool-failure";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { Workspace } from "../database/workspace-schema";
import {
  getAvailableModels,
  getDefaultModelId,
  getDefaultFreeModelId,
} from "../agent-lib/ai-models";
import { getWorkspaceGatewayModelListings } from "../services/model-catalog.service";
import { loggers, enrichContextWithWorkspace } from "../logging";
import { getEffectiveBillingPlan } from "../billing/config";
import { getAllAgentMeta } from "../agents";
import { AUTH_SECURITY, OPEN_RESPONSES, createRouter } from "../openapi/core";
import {
  resumeChatStream,
  stopChatGeneration,
} from "../services/agent-stream.service";
import { handleChatTurn } from "../services/agent-chat/handle-chat-turn";
import {
  authorizeWorkspaceAccess,
  resolveChatActor,
  type ChatRequestBody,
} from "../services/agent-chat/request";
import { fail } from "./lib/respond";

const logger = loggers.agent();

export const agentRoutes = createRouter();

const ChatIdParam = z.object({
  chatId: z.string().openapi({ param: { name: "chatId", in: "path" } }),
});
const StreamResponses = {
  ...OPEN_RESPONSES,
  200: {
    description: "Streaming response (AI SDK UI message stream / SSE).",
    content: { "text/event-stream": { schema: z.string() } },
  },
};

// Apply unified auth middleware to all routes
agentRoutes.use("*", unifiedAuthMiddleware);

/**
 * GET /models - List available AI models for the current workspace.
 *
 * Returns the super-admin-curated catalog minus any model IDs the workspace
 * has explicitly disabled via `settings.disabledModelIds`. When no workspace
 * is in scope (no header / no active workspace) we return the full curated
 * catalog.
 *
 * Also returns `recommendedModelId`: the plan-aware default the chat endpoint
 * would fall back to if the client sent an unknown/hidden model. The client
 * uses this to reset the model picker when its persisted selection is no
 * longer available (e.g. super-admin hid the previously-selected model), so
 * the UI matches what the server will actually run.
 */
agentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/models",
    tags: ["Agent"],
    summary: "List available AI models",
    security: AUTH_SECURITY,
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    try {
      const workspaceId =
        c.req.header("x-workspace-id") || c.get("session")?.activeWorkspaceId;

      let models: Awaited<ReturnType<typeof getAvailableModels>> = [];
      let effectivePlan: ReturnType<typeof getEffectiveBillingPlan> = "free";

      if (workspaceId) {
        const ws = await Workspace.findById(workspaceId)
          .select({
            "settings.disabledModelIds": 1,
            "billing.plan": 1,
            "billing.subscriptionStatus": 1,
          })
          .lean();

        effectivePlan = getEffectiveBillingPlan(ws?.billing);
        models = await getAvailableModels(ws?.settings?.disabledModelIds);
      } else {
        models = await getAvailableModels();
      }

      const platformDefault =
        effectivePlan === "free"
          ? await getDefaultFreeModelId()
          : await getDefaultModelId();

      // Only surface the platform default if it's actually in the returned
      // list — otherwise the client would set an id the selector can't render.
      // Fall back to the first available model, matching legacy behaviour.
      const recommendedModelId = models.some(m => m.id === platformDefault)
        ? platformDefault
        : (models[0]?.id ?? null);

      return c.json({ models, recommendedModelId });
    } catch (err) {
      logger.error("Failed to load models", { error: err });
      return c.json({ models: [], recommendedModelId: null }, 200);
    }
  },
);

/**
 * GET /gateway-models - Model catalog available to workspaces.
 *
 * Returns the super-admin-curated catalog from MongoDB (same source as
 * GET /models). Avoids a live fetch to ai-gateway.vercel.sh in the request
 * path — that upstream call is refreshed out-of-band by Inngest/startup.
 */
agentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/gateway-models",
    tags: ["Agent"],
    summary: "List gateway models with curation",
    security: AUTH_SECURITY,
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const models = await getWorkspaceGatewayModelListings();
    return c.json({ models });
  },
);

/**
 * GET /agents - List available agent modes
 */
agentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/agents",
    tags: ["Agent"],
    summary: "List available agents",
    security: AUTH_SECURITY,
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const agents = getAllAgentMeta();
    return c.json({ agents });
  },
);

/**
 * Browser-executed tools have no server-side execution span. Report their
 * domain failures explicitly so production's JSON sink forwards them to
 * Google Cloud Logging with chat/workspace correlation.
 */
agentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/client-tool-failure",
    tags: ["Agent"],
    summary: "Report a browser-executed agent tool failure",
    security: AUTH_SECURITY,
    request: {
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({
              workspaceId: z.string(),
              chatId: z.string().max(128),
              toolName: z.string().min(1).max(128),
              toolCallId: z.string().min(1).max(256),
              error: z.string().min(1).max(2_000),
              code: z.string().max(128).optional(),
            }),
          },
        },
      },
    },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const report = c.req.valid("json");

    if (!ObjectId.isValid(report.workspaceId)) {
      return fail(c, 400, "Invalid workspaceId");
    }
    const denied = await authorizeWorkspaceAccess(
      { user: c.get("user"), workspace: c.get("workspace") },
      report.workspaceId,
    );
    if (denied) return fail(c, denied.status, denied.error);

    enrichContextWithWorkspace(report.workspaceId);
    const toolErrorMessage = sanitizeToolFailureMessage(report.error);
    logger.error("Client agent tool failed", {
      workspaceId: report.workspaceId,
      chatId: report.chatId,
      toolName: report.toolName,
      toolCallId: report.toolCallId,
      toolErrorMessage,
      toolErrorCode: report.code,
      toolExecution: "browser",
      error: {
        name: "ToolExecutionError",
        message: toolErrorMessage,
        ...(report.code ? { code: report.code } : {}),
      },
    });
    return c.json({ success: true as const }, 200);
  },
);

/**
 * POST /api/agent/chat
 * useChat-compatible endpoint using native AI SDK streaming
 */
agentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/chat",
    tags: ["Agent"],
    summary: "Stream an agent chat turn",
    description:
      "Runs an agent chat turn and streams the response using the Vercel AI SDK UI message stream protocol.",
    security: AUTH_SECURITY,
    request: {
      body: {
        required: false,
        content: {
          "application/json": { schema: z.record(z.string(), z.any()) },
        },
      },
    },
    responses: { ...StreamResponses },
  }),
  async c => {
    // Allow both session auth (user) and API key auth (workspace).
    const principal = {
      user: c.get("user"),
      workspace: c.get("workspace"),
      apiKey: c.get("apiKey"),
    };
    const actor = resolveChatActor(principal);
    if (!actor) return fail(c, 401, "Unauthorized");

    let body: ChatRequestBody;
    try {
      body = await c.req.json();
    } catch (e) {
      logger.error("Error parsing request body", { error: e });
      return fail(c, 400, "Invalid request body");
    }

    const outcome = await handleChatTurn({ principal, ...actor, body });
    switch (outcome.kind) {
      case "stream":
        return outcome.response;
      case "billing":
        // The billing check's own `{ code, message, ... }` body: the chat UI
        // parses it to render the upgrade prompt.
        return c.json(outcome.body, outcome.status);
      case "failure":
        return fail(c, outcome.status, outcome.error);
    }
  },
);

/**
 * GET /api/agent/chat/:chatId/stream
 *
 * Resume endpoint for useChat({ resume: true }). Reattaches the caller to
 * the chat's in-flight turn: buffered chunks are replayed, then live chunks
 * follow. Multiple clients may attach to the same stream concurrently.
 * Responds 204 when nothing is streaming — the client then renders the chat
 * persisted in MongoDB.
 */
agentRoutes.openapi(
  createRoute({
    method: "get",
    path: "/chat/{chatId}/stream",
    tags: ["Agent"],
    summary: "Resume an in-flight chat stream",
    security: AUTH_SECURITY,
    request: { params: ChatIdParam },
    responses: { ...StreamResponses },
  }),
  async c => {
    const chatId = c.req.param("chatId");
    const result = await resumeChatStream(c, chatId);
    if (result.kind === "no-content") return c.body(null, 204);
    if (result.kind === "forbidden") {
      return fail(c, result.status, "Cannot access chat stream");
    }
    return result.response;
  },
);

/**
 * POST /api/agent/chat/:chatId/stop
 *
 * Explicitly aborts the chat's in-flight generation. With resumable streams a
 * client disconnect (refresh, tab close) intentionally no longer cancels the
 * turn, so the Stop button calls this endpoint. Aborting triggers the normal
 * onFinish(isAborted) path, which persists the partial assistant message and
 * clears the resume pointer.
 */
agentRoutes.openapi(
  createRoute({
    method: "post",
    path: "/chat/{chatId}/stop",
    tags: ["Agent"],
    summary: "Stop an in-flight chat generation",
    security: AUTH_SECURITY,
    request: { params: ChatIdParam },
    responses: { ...OPEN_RESPONSES },
  }),
  async c => {
    const chatId = c.req.param("chatId");
    const result = await stopChatGeneration(c, chatId);
    if (result.kind === "not-found") return c.json({ stopped: false });
    if (result.kind === "forbidden") {
      return fail(c, result.status, "Cannot access chat");
    }
    return c.json({ stopped: result.stopped });
  },
);

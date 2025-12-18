/**
 * Agent V3 Routes
 * Native Vercel AI SDK streaming protocol for useChat compatibility
 */

import { Hono } from "hono";
import { ObjectId } from "mongodb";
import {
  streamText,
  convertToModelMessages,
  stepCountIs,
  type UIMessage,
  type LanguageModel,
} from "ai";
import { openai } from "@ai-sdk/openai";
import { anthropic } from "@ai-sdk/anthropic";
import { google } from "@ai-sdk/google";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import type { ConsoleDataV2 } from "../agent-v2/types";
import { createUniversalToolsV3 } from "../agent-v2/tools/universal-tools-v3";
import { UNIVERSAL_PROMPT_V2 } from "../agent-v2/prompts/universal";
import { getModelById } from "../agent-v2/ai-models";
import { Workspace, DatabaseConnection } from "../database/workspace-schema";

export const agentV3Routes = new Hono();

// Apply unified auth middleware to all routes
agentV3Routes.use("*", unifiedAuthMiddleware);

/**
 * Get the AI SDK model instance based on the model ID
 */
function getModelInstance(modelId?: string): LanguageModel {
  if (!modelId) {
    return openai("gpt-5.2");
  }

  const model = getModelById(modelId);
  if (!model) {
    console.warn(
      `[Agent V3] Model "${modelId}" not found, falling back to gpt-5.2`,
    );
    return openai("gpt-5.2");
  }

  switch (model.provider) {
    case "openai":
      return openai(modelId);
    case "anthropic":
      return anthropic(modelId);
    case "google":
      return google(modelId);
    default:
      console.warn(
        `[Agent V3] Unknown provider for model "${modelId}", falling back to gpt-5.2`,
      );
      return openai("gpt-5.2");
  }
}

/**
 * POST /api/agent-v3/chat
 * useChat-compatible endpoint using native AI SDK streaming
 */
agentV3Routes.post("/chat", async (c: AuthenticatedContext) => {
  const user = c.get("user");
  const userId = user?.id;

  if (!userId) {
    return c.json({ error: "User not authenticated" }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch (e) {
    console.error("[Agent V3] Error parsing request body", e);
    return c.json({ error: "Invalid request body" }, 400);
  }

  const { messages, workspaceId, consoles, consoleId, modelId } = body as {
    messages?: UIMessage[];
    workspaceId?: string;
    consoles?: ConsoleDataV2[];
    consoleId?: string;
    modelId?: string;
  };

  if (!messages || !Array.isArray(messages) || messages.length === 0) {
    return c.json({ error: "'messages' array is required" }, 400);
  }

  if (!workspaceId || !ObjectId.isValid(workspaceId)) {
    return c.json(
      { error: "'workspaceId' is required and must be valid" },
      400,
    );
  }

  // Load workspace for custom prompt
  let workspaceCustomPrompt = "";
  try {
    const workspace = await Workspace.findById(workspaceId).select({
      settings: 1,
    });
    workspaceCustomPrompt = workspace?.settings?.customPrompt || "";
  } catch (err) {
    console.warn("[Agent V3] Failed to load workspace custom prompt:", err);
  }

  // Get workspace database capabilities for enriching consoles
  const workspaceDatabases = await DatabaseConnection.find({
    workspaceId: new ObjectId(workspaceId),
  }).select({ type: 1, name: 1 });

  const databaseTypeMap = new Map<string, string>();
  workspaceDatabases.forEach(db => {
    databaseTypeMap.set(db._id.toString(), db.type);
  });

  // Enrich consoles with connection type information
  const enrichedConsoles: ConsoleDataV2[] = (consoles || []).map(
    (c: ConsoleDataV2) => ({
      ...c,
      connectionType:
        c.connectionType ||
        (c.connectionId ? databaseTypeMap.get(c.connectionId) : undefined),
    }),
  );

  // Get tools (V3 uses client-side console tools)
  const tools = createUniversalToolsV3(
    workspaceId,
    enrichedConsoles,
    consoleId,
  );

  // Build system prompt
  const systemPrompt = UNIVERSAL_PROMPT_V2;
  const customPromptContext =
    workspaceCustomPrompt.trim().length > 0
      ? `\n\n---\n\n### Workspace Context\n${workspaceCustomPrompt.trim()}`
      : "";

  const consoleContext =
    enrichedConsoles.length > 0
      ? `\n\nAvailable consoles:\n${enrichedConsoles
          .map(
            (c, i) =>
              `${i + 1}. "${c.title}" (ID: ${c.id}, Type: ${c.connectionType || "unknown"}${c.databaseName ? `, DB: ${c.databaseName}` : ""})`,
          )
          .join("\n")}`
      : "";

  // Get model instance
  const model = getModelInstance(modelId);
  console.log(`[Agent V3] Using model: ${modelId || "gpt-5.2 (default)"}`);

  // Convert UI messages (from useChat) to model messages (for streamText)
  // Note: convertToModelMessages is async in AI SDK v6
  const modelMessages = await convertToModelMessages(messages);

  // Guardrail: prevent runaway multi-step tool loops in production.
  // The AI SDK defaults to stopWhen: stepCountIs(1). We intentionally allow multi-step,
  // but keep a firm upper bound.
  const MAX_STEPS = 256;
  let stepsCompleted = 0;

  const result = streamText({
    model,
    system: systemPrompt + customPromptContext + consoleContext,
    messages: modelMessages,
    tools: tools as Parameters<typeof streamText>[0]["tools"],
    stopWhen: stepCountIs(MAX_STEPS),
    onStepFinish: ({ toolCalls, toolResults }) => {
      stepsCompleted += 1;
      console.log("[Agent V3] Step finished:", {
        step: stepsCompleted,
        maxSteps: MAX_STEPS,
        toolCallCount: toolCalls?.length,
        toolResultCount: toolResults?.length,
      });

      if (stepsCompleted >= MAX_STEPS) {
        console.warn(
          `[Agent V3] Step limit reached (${MAX_STEPS}). Terminating tool loop to prevent runaway execution.`,
        );
      }
    },
  });

  // Return native AI SDK UI message stream response (for useChat compatibility)
  return result.toUIMessageStreamResponse();
});

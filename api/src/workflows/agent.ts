/**
 * Mako's own agent, for a workflow step: the same modes, tool budget, skills
 * and permission checks as in chat (`buildUnifiedModeRuntime`), with a goal in
 * and the answer out. Nothing is streamed to anyone. The run is kept as a
 * chat marked `source: "workflow"`, which the chat history leaves out, so
 * what the agent did can be read afterwards.
 */
import {
  convertToModelMessages,
  stepCountIs,
  streamText,
  type UIMessage,
} from "ai";
import { Types } from "mongoose";

import { getModel } from "../agent-lib/ai-gateway";
import { getDefaultModelId } from "../agent-lib/ai-models";
import { withToolOutputBackstop } from "../agent-lib/tools/shared/output-cap";
import { buildUnifiedModeRuntime } from "../agents/modes/runtime";
import { checkBillingLimits } from "../billing/usage-limit.middleware";
import { Chat } from "../database/workspace-schema";
import { saveChat } from "../services/agent-thread.service";
import { trackUsage } from "../services/llm-usage.service";
import { HatchetError } from "./hatchet";

const DEFAULT_MAX_STEPS = 30;
const MAX_STEPS = 100;

export async function runStepAgent(params: {
  workspaceId: string;
  /** Who the agent acts as: the person who set the workspace's worker up. */
  userId: string;
  goal: string;
  modelId?: string;
  maxSteps?: number;
}): Promise<{ text: string; toolCalls: string[]; chatId: string }> {
  const { workspaceId, userId, goal } = params;
  const modelId = params.modelId ?? (await getDefaultModelId());
  const limits = await checkBillingLimits(workspaceId, modelId);
  if (!limits.allowed) {
    throw new HatchetError(
      limits.error?.message ?? "Usage limit reached",
      limits.statusCode ?? 402,
    );
  }

  const messages: UIMessage[] = [
    { id: "goal", role: "user", parts: [{ type: "text", text: goal }] },
  ];
  const runtime = buildUnifiedModeRuntime({
    context: { workspaceId, userId },
    messages,
    modelId,
    headless: true,
  });
  const startedAt = Date.now();
  const result = streamText({
    model: getModel(modelId),
    system: runtime.system,
    messages: await convertToModelMessages(messages),
    tools: withToolOutputBackstop(runtime.tools),
    prepareStep: runtime.prepareStep,
    stopWhen: stepCountIs(
      Math.min(params.maxSteps ?? DEFAULT_MAX_STEPS, MAX_STEPS),
    ),
  });

  // Draining the UI stream is what builds the messages a chat is made of.
  let transcript = messages;
  const stream = result.toUIMessageStream({
    originalMessages: messages,
    onFinish: ({ messages: all }) => {
      transcript = all;
    },
  });
  for await (const _part of stream) void _part;

  const chatId = new Types.ObjectId();
  await Chat.create({
    _id: chatId,
    workspaceId: new Types.ObjectId(workspaceId),
    createdBy: userId,
    title: goal.slice(0, 80),
    titleGenerated: true,
    source: "workflow",
    messages: [],
  });
  await saveChat(chatId.toString(), workspaceId, userId, transcript);

  const usage = await result.totalUsage;
  void trackUsage({
    workspaceId,
    userId,
    invocationType: "workflow",
    modelId,
    inputTokens: usage.inputTokens ?? 0,
    outputTokens: usage.outputTokens ?? 0,
    totalTokens: usage.totalTokens ?? 0,
    durationMs: Date.now() - startedAt,
  });
  return {
    text: await result.text,
    toolCalls: (await result.steps).flatMap(step =>
      step.toolCalls.map(call => call.toolName),
    ),
    chatId: chatId.toString(),
  };
}

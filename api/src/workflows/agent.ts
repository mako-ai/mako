/**
 * Mako's own agent, for a workflow step: the same modes, tool budget, skills
 * and permission checks as in chat (`buildUnifiedModeRuntime`), with a goal in
 * and the answer out. Nothing is streamed to anyone. The run is kept as a
 * chat marked `source: "workflow"`, which the chat history leaves out, so
 * what the agent did can be read afterwards.
 */
import { withToolQueryLabels } from "../agent-lib/tool-query-labels";
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
/** A step's agent run ends here whatever the model does; the step's own
 * executionTimeout is usually shorter. */
const TIME_LIMIT_MS = 10 * 60_000;

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
  // Reads only, like the worker's own key: a step that must write does it
  // through a tool made for that, not through SQL nobody reviewed.
  const runtime = buildUnifiedModeRuntime({
    context: { workspaceId, userId, queryAccess: "read" },
    messages,
    modelId,
    headless: true,
  });
  const startedAt = Date.now();
  // What ran is recorded whatever happens next: the transcript as a chat and
  // the tokens as usage, after a clean finish, an error or the time limit.
  const toolCalls: string[] = [];
  let inputTokens = 0;
  let outputTokens = 0;
  const result = streamText({
    model: getModel(modelId),
    system: runtime.system,
    messages: await convertToModelMessages(messages),
    tools: withToolOutputBackstop(
      withToolQueryLabels(runtime.tools, {
        mako_trigger: "workflow",
        mako_user: userId,
        mako_workspace: workspaceId,
      }),
    ),
    prepareStep: runtime.prepareStep,
    stopWhen: stepCountIs(
      Math.min(params.maxSteps ?? DEFAULT_MAX_STEPS, MAX_STEPS),
    ),
    abortSignal: AbortSignal.timeout(TIME_LIMIT_MS),
    onStepFinish: step => {
      inputTokens += step.usage.inputTokens ?? 0;
      outputTokens += step.usage.outputTokens ?? 0;
      toolCalls.push(...step.toolCalls.map(call => call.toolName));
    },
  });

  // Draining the UI stream is what builds the messages a chat is made of.
  let transcript = messages;
  let text = "";
  let failure: unknown;
  const chatId = new Types.ObjectId();
  try {
    const stream = result.toUIMessageStream({
      originalMessages: messages,
      onFinish: ({ messages: all }) => {
        transcript = all;
      },
    });
    for await (const _part of stream) void _part;
    // A model error or the time limit ends the stream quietly and rejects
    // here, where it is reported like any other failure.
    text = await result.text;
  } catch (error) {
    failure = error;
  } finally {
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
    void trackUsage({
      workspaceId,
      userId,
      invocationType: "workflow",
      modelId,
      inputTokens,
      outputTokens,
      totalTokens: inputTokens + outputTokens,
      durationMs: Date.now() - startedAt,
    });
  }
  if (failure) {
    const why = failure instanceof Error ? failure.message : String(failure);
    throw new HatchetError(`The agent did not finish: ${why}`, 502);
  }
  return { text, toolCalls, chatId: chatId.toString() };
}

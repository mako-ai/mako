/**
 * Finalization of one generation segment, run through the per-chat
 * finalization queue once the UI message stream ends (see run-segment.ts for
 * why it is queued rather than awaited). In order:
 *
 *   1. cancel database executions the turn left running;
 *   2. commit the WIP this turn's apps tools produced;
 *   3. aggregate usage and price it;
 *   4. track usage (fire-and-forget) and save the chat;
 *   5. continue a turn stranded on client-only tools, if any;
 *   6. otherwise clear the resume pointer and announce the chat idle;
 *   7. request console descriptions with the turn's context.
 */
import type { UIMessage } from "ai";

import { commitAgentTurn } from "../../apps/worktree.service";
import { requestConsoleDescription } from "../../apps/workspace-consoles.service";
import { loggers } from "../../logging";
import { chatRepo } from "../../repositories/chat";
import { saveChat } from "../agent-thread.service";
import {
  extractConsoleContextFromMessages,
  isDescriptionGenAvailable,
} from "../console-description.service";
import { computeInvocationCost } from "../cost-calculator";
import { trackUsage } from "../llm-usage.service";
import { publishRealtimeEvent } from "../realtime.service";
import { clearActiveGeneration } from "../resumable-stream.service";
import { maybeContinueStrandedTurn } from "./stranded-turn";
import type { ChatTurn } from "./turn";
import {
  aggregateStepUsage,
  totalsFromUsage,
  type StepUsageDetail,
  type TokenTotals,
} from "./turn-usage";

const logger = loggers.agent();

/** The parts of a streamText result finalization reads. */
export interface SegmentResult {
  steps: PromiseLike<unknown>;
  usage: PromiseLike<unknown>;
}

export interface FinalizeSegmentInput {
  turn: ChatTurn;
  result: SegmentResult;
  allMessages: UIMessage[];
  isAborted: boolean;
  startTime: number;
  continuationDepth: number;
  /**
   * The resume-pointer stream id, minted once the SSE stream starts — read
   * when finalization runs, not when it is scheduled.
   */
  getStreamId: () => string | null;
  runSegment: Parameters<typeof maybeContinueStrandedTurn>[0]["runSegment"];
}

/**
 * Apps (Cursor-cloud model): turn the WIP this turn's apps tools produced
 * into one commit per turn, scoped to the app folders THIS chat actually
 * wrote to — the sandbox is shared across the user's chats, so an unscoped
 * commit would sweep a concurrent chat's in-flight work on another app.
 * No-op when the turn touched no app; never throws.
 */
async function commitAppsTurn(
  turn: ChatTurn,
  allMessages: UIMessage[],
): Promise<void> {
  try {
    const lastUserText = [...allMessages]
      .reverse()
      .find(m => m.role === "user")
      ?.parts?.filter(
        (p): p is { type: "text"; text: string } =>
          (p as { type?: string }).type === "text",
      )
      .map(p => p.text)
      .join(" ");
    await commitAgentTurn(turn.workspaceId, turn.actorId, lastUserText, [
      ...turn.appsTouchedPaths,
    ]);
  } catch (err) {
    logger.warn("Apps turn commit failed", { error: err });
  }
}

/** Per-step usage when the steps report it, else the top-level usage. */
async function collectSegmentUsage(
  result: SegmentResult,
  modelId: string,
): Promise<{ totals: TokenTotals; stepDetails: StepUsageDetail[] }> {
  let steps: Array<Record<string, unknown>> = [];
  try {
    steps = (await result.steps) as Array<Record<string, unknown>>;
  } catch (err) {
    logger.warn("Failed to get steps from result", { error: err });
  }

  const aggregated = aggregateStepUsage(steps, modelId);
  if (aggregated.stepDetails.length > 0) return aggregated;

  try {
    const usage = (await result.usage) as Record<string, unknown> | undefined;
    return { totals: totalsFromUsage(usage), stepDetails: [] };
  } catch (err) {
    logger.warn("Failed to get usage from model", { error: err });
    return aggregated;
  }
}

/** Drop the resume pointer so reconnecting clients load the saved chat. */
async function clearResumePointer(
  turn: ChatTurn,
  streamId: string,
): Promise<void> {
  const { chatId, workspaceId } = turn;
  clearActiveGeneration(chatId, streamId);
  try {
    // Guarded on the streamId so a newer turn's pointer is never clobbered.
    await chatRepo.clearActiveStreamIfMatch(workspaceId, chatId, streamId);
  } catch (error) {
    logger.warn("Failed to clear activeStreamId", { error, chatId });
  }
  publishRealtimeEvent(workspaceId, {
    type: "chat.activity",
    chatId,
    state: "idle",
  });
}

export async function finalizeSegment(
  input: FinalizeSegmentInput,
): Promise<void> {
  const { turn, result, allMessages, isAborted } = input;
  const { chatId, workspaceId, actorId, modelId } = turn;

  if (turn.abort.executionIds.size > 0) {
    await turn.abort.cancelRegisteredExecutions();
    turn.abort.executionIds.clear();
  }
  const durationMs = Date.now() - input.startTime;

  if (!isAborted && turn.appsTouchedPaths.size > 0) {
    await commitAppsTurn(turn, allMessages);
  }

  const usage = await collectSegmentUsage(result, modelId);
  const {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
  } = usage.totals;
  let stepDetails = usage.stepDetails;
  const totalTokens = inputTokens + outputTokens;

  logger.info(
    isAborted
      ? "Stream aborted, saving partial chat"
      : "Stream finished, saving chat",
    {
      chatId,
      isAborted,
      messageCount: allMessages.length,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      totalTokens,
      durationMs,
    },
  );

  // Cost before saving so both trackUsage and saveChat receive it.
  let costUsd: number | undefined;
  try {
    const costResult = await computeInvocationCost({
      modelId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      steps: stepDetails,
    });
    costUsd = costResult.totalCostUsd;
    if (costResult.steps) stepDetails = costResult.steps;
  } catch (err) {
    logger.warn("Failed to compute invocation cost", { error: err });
  }

  void trackUsage({
    workspaceId,
    userId: actorId,
    chatId,
    invocationType: "chat",
    modelId,
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    totalTokens,
    steps: stepDetails,
    agentId: turn.agentId,
    durationMs,
    costUsd,
  }).catch(err => logger.warn("Failed to track LLM usage", { error: err }));

  try {
    await saveChat(chatId, workspaceId, actorId, allMessages, {
      promptTokens: inputTokens,
      completionTokens: outputTokens,
      totalTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      costUsd,
      model: modelId,
    });
  } catch (error) {
    logger.error("Error saving chat", { error });
  }

  // When a continuation starts it owns the resume pointer, so the clear
  // below is skipped.
  let continued = false;
  try {
    continued = await maybeContinueStrandedTurn({
      turn,
      allMessages,
      isAborted,
      continuationDepth: input.continuationDepth,
      segmentStreamId: input.getStreamId(),
      runSegment: input.runSegment,
    });
  } catch (error) {
    logger.warn("Stranded-turn continuation failed", { error, chatId });
  }

  const streamId = input.getStreamId();
  if (!continued && streamId) {
    await clearResumePointer(turn, streamId);
  }

  // The turn's context (what was asked, what came back) only exists here; it
  // rides along on the derivation request and pre-empts the push-driven
  // baseline (apps.md §16.4).
  if (isDescriptionGenAvailable()) {
    const consoleContexts = extractConsoleContextFromMessages(allMessages);
    for (const [consoleId, ctx] of consoleContexts) {
      requestConsoleDescription({
        workspaceId,
        consoleId,
        context: {
          conversationExcerpt: ctx.conversationExcerpt,
          resultSample: ctx.resultSample,
        },
        tracking: { userId: actorId, userEmail: turn.actorEmail },
      });
    }
  }
}

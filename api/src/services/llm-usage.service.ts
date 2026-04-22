/**
 * LLM Usage Tracking Service
 *
 * Records per-invocation token usage and cost to the LlmUsage collection.
 * Designed to be called fire-and-forget so it never blocks request handling.
 */

import { ObjectId } from "mongodb";
import { LlmUsage } from "../database/schema";
import { computeInvocationCost } from "./cost-calculator";
import { loggers } from "../logging";

const logger = loggers.app();

export interface TrackUsageParams {
  workspaceId: string;
  userId: string;
  chatId?: string;
  invocationType:
    | "chat"
    | "title_generation"
    | "description_generation"
    | "embedding"
    | "version_comment";
  modelId: string;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  totalTokens: number;
  steps?: Array<{
    modelId: string;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    reasoningTokens: number;
    costUsd: number;
  }>;
  agentId?: string;
  tags?: string[];
  durationMs?: number;
  costUsd?: number;
}

/**
 * Record a single LLM invocation.
 * Computes cost from the ModelPricing collection, then persists to LlmUsage.
 *
 * This function should be called fire-and-forget:
 *   void trackUsage(params).catch(err => logger.warn(...));
 */
export async function trackUsage(params: TrackUsageParams): Promise<void> {
  try {
    let totalCostUsd = params.costUsd ?? 0;
    let costedSteps = params.steps;

    if (params.costUsd == null) {
      const result = await computeInvocationCost({
        modelId: params.modelId,
        inputTokens: params.inputTokens,
        outputTokens: params.outputTokens,
        cacheReadTokens: params.cacheReadTokens,
        cacheWriteTokens: params.cacheWriteTokens,
        reasoningTokens: params.reasoningTokens,
        steps: params.steps,
      });
      totalCostUsd = result.totalCostUsd;
      costedSteps = result.steps;
    }

    await LlmUsage.create({
      workspaceId: new ObjectId(params.workspaceId),
      userId: params.userId,
      chatId: params.chatId ? new ObjectId(params.chatId) : undefined,
      invocationType: params.invocationType,
      modelId: params.modelId,
      inputTokens: params.inputTokens,
      outputTokens: params.outputTokens,
      cacheReadTokens: params.cacheReadTokens ?? 0,
      cacheWriteTokens: params.cacheWriteTokens ?? 0,
      reasoningTokens: params.reasoningTokens ?? 0,
      totalTokens: params.totalTokens,
      costUsd: totalCostUsd,
      steps: costedSteps,
      agentId: params.agentId,
      tags: params.tags,
      durationMs: params.durationMs,
    });
  } catch (err) {
    logger.warn("Failed to persist LLM usage record", { error: err });
  }
}

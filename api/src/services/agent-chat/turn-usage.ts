/**
 * Usage accounting for a generation segment: the AI SDK reports usage per
 * step (each step may run on a different model after a fallback), and the
 * authoritative cost is priced per step. Pure functions so the arithmetic is
 * testable without a stream.
 */
import { extractTokenCounts, toNum } from "../../utils/safe-num";

export interface TokenTotals {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  reasoningTokens: number;
}

export interface StepUsageDetail extends TokenTotals {
  modelId: string;
  costUsd: number;
}

/** Cache/reasoning counts from one usage record (step or top-level). */
function detailCounts(usage: Record<string, unknown> | undefined) {
  const details = usage?.inputTokenDetails as
    Record<string, unknown> | undefined;
  const outDetails = usage?.outputTokenDetails as
    Record<string, unknown> | undefined;
  return {
    cacheReadTokens: toNum(details?.cacheReadTokens),
    cacheWriteTokens: toNum(details?.cacheWriteTokens),
    reasoningTokens: toNum(outDetails?.reasoningTokens),
  };
}

/**
 * Totals and per-step details across `steps`. Steps without usage are
 * skipped; a step without a response model id is attributed to
 * `fallbackModelId`. `costUsd` is 0 here — the cost calculator fills it in.
 */
export function aggregateStepUsage(
  steps: Array<Record<string, unknown>>,
  fallbackModelId: string,
): { totals: TokenTotals; stepDetails: StepUsageDetail[] } {
  const totals: TokenTotals = {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  };
  const stepDetails: StepUsageDetail[] = [];

  for (const step of steps) {
    const usage = step.usage as Record<string, unknown> | undefined;
    if (!usage) continue;

    const { inputTokens, outputTokens } = extractTokenCounts(usage);
    const { cacheReadTokens, cacheWriteTokens, reasoningTokens } =
      detailCounts(usage);

    totals.inputTokens += inputTokens;
    totals.outputTokens += outputTokens;
    totals.cacheReadTokens += cacheReadTokens;
    totals.cacheWriteTokens += cacheWriteTokens;
    totals.reasoningTokens += reasoningTokens;

    const stepModelId = (step.response as Record<string, unknown> | undefined)
      ?.modelId as string | undefined;

    stepDetails.push({
      modelId: stepModelId || fallbackModelId,
      inputTokens,
      outputTokens,
      cacheReadTokens,
      cacheWriteTokens,
      reasoningTokens,
      costUsd: 0,
    });
  }
  return { totals, stepDetails };
}

/** Totals from the top-level usage record (used when no step had usage). */
export function totalsFromUsage(
  usage: Record<string, unknown> | undefined,
): TokenTotals {
  const { inputTokens, outputTokens } = extractTokenCounts(usage ?? {});
  return { inputTokens, outputTokens, ...detailCounts(usage) };
}

/** The finish part's `totalUsage` in the shape the cost calculator prices. */
export function totalsFromFinishUsage(
  usage:
    | {
        inputTokens?: unknown;
        outputTokens?: unknown;
        inputTokenDetails?: {
          cacheReadTokens?: unknown;
          cacheWriteTokens?: unknown;
        };
        outputTokenDetails?: { reasoningTokens?: unknown };
      }
    | undefined,
): TokenTotals {
  return {
    inputTokens: toNum(usage?.inputTokens),
    outputTokens: toNum(usage?.outputTokens),
    cacheReadTokens: toNum(usage?.inputTokenDetails?.cacheReadTokens),
    cacheWriteTokens: toNum(usage?.inputTokenDetails?.cacheWriteTokens),
    reasoningTokens: toNum(usage?.outputTokenDetails?.reasoningTokens),
  };
}

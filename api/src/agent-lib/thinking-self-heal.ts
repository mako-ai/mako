/**
 * Runtime self-heal for Anthropic thinking-mode misclassification.
 *
 * Safety net behind the catalog probe (model-catalog.service.ts): if a
 * request still goes out with the manual `{type: "enabled", budgetTokens}`
 * payload against an adaptive-only model, Anthropic rejects it with
 *
 *   '"thinking.type.enabled" is not supported for this model. Use
 *    "thinking.type.adaptive" and "output_config.effort" ...'
 *
 * This middleware catches exactly that error, persists the corrected mode to
 * the catalog capabilities snapshot (so every later request — and every other
 * API instance after cache expiry — is right from the start), and retries the
 * in-flight call once with the adaptive payload. The user never sees the 400.
 */

import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import { thinkingErrorRequiresAdaptive } from "./anthropic-thinking";
import { saveProbedThinkingMode } from "../services/model-catalog.service";
import { loggers } from "../logging";

const logger = loggers.app();

function withAdaptiveThinking<
  T extends { providerOptions?: Record<string, Record<string, unknown>> },
>(params: T): T {
  const providerOptions = {
    ...(params.providerOptions ?? {}),
    anthropic: {
      ...(params.providerOptions?.anthropic ?? {}),
      thinking: { type: "adaptive", display: "summarized" },
    },
  };
  return { ...params, providerOptions } as T;
}

/**
 * Wrap a gateway model so that an adaptive-only 400 triggers persist + retry.
 * Only meaningful for Anthropic models requested with a manual thinking
 * payload; for everything else the middleware is a transparent pass-through
 * (the error predicate never matches).
 */
export function withThinkingSelfHeal(
  model: LanguageModel,
  modelId: string,
): LanguageModel {
  const heal = async (error: unknown): Promise<boolean> => {
    if (!thinkingErrorRequiresAdaptive(error)) return false;
    logger.warn(
      "Model rejected manual thinking payload; self-healing to adaptive",
      { modelId },
    );
    try {
      await saveProbedThinkingMode(modelId, "adaptive");
    } catch (err) {
      // Persisting is best-effort; still retry the in-flight call.
      logger.error("Failed to persist self-healed thinking mode", {
        modelId,
        error: String(err),
      });
    }
    return true;
  };

  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate, params, model: inner }) => {
      try {
        return await doGenerate();
      } catch (error) {
        if (!(await heal(error))) throw error;
        return inner.doGenerate(withAdaptiveThinking(params));
      }
    },
    wrapStream: async ({ doStream, params, model: inner }) => {
      try {
        // The adaptive-only rejection is a request-time 400: doStream()
        // rejects before the first chunk, so a whole-call retry is safe
        // (no partial output has been emitted).
        return await doStream();
      } catch (error) {
        if (!(await heal(error))) throw error;
        return inner.doStream(withAdaptiveThinking(params));
      }
    },
  };

  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware,
  }) as unknown as LanguageModel;
}

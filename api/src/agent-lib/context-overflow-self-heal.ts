/**
 * Reactive, provider-agnostic backstop for context-window overflow.
 *
 * The proactive compactor (`context/compaction.ts`) keeps the prompt under a
 * budget computed from the model's catalog `contextWindow`. That budget relies
 * on a token *estimate*, and tool-output sizes are heavy-tailed — so an
 * occasional request can still slip past the real ceiling (or the context
 * window may be unknown, in which case proactive budgeting is skipped). When
 * that happens the provider rejects the request at request time with a
 * "prompt is too long" / "context_length_exceeded" / token-count 400.
 *
 * This middleware mirrors `withThinkingSelfHeal`: it catches exactly that class
 * of error in `wrapStream`/`wrapGenerate` and retries ONCE with the prompt
 * aggressively trimmed to the most recent user turns. The rejection is a
 * request-time 400 (no partial output emitted), so a whole-call retry is safe.
 * It is provider-neutral — the trim operates on the AI SDK `ModelMessage[]`
 * shape every provider receives — so it works for OpenAI, Anthropic, Google,
 * and anything else routed through the gateway.
 *
 * Single retry (never loops): if the trimmed request still overflows, the
 * original error surfaces and the route shows a friendly "chat too long"
 * message. That bounded behavior is the circuit breaker.
 */

import {
  wrapLanguageModel,
  type LanguageModel,
  type LanguageModelMiddleware,
} from "ai";
import { loggers } from "../logging";

const logger = loggers.agent();

const OVERFLOW_PATTERNS =
  /context[_ ]length|maximum context|prompt is too long|input is too long|too many (input )?tokens|exceeds the (maximum|context)|model_context_window_exceeded|reduce the length of the (messages|prompt)|token count .* exceeds/i;

/** Keep at most this many trailing user turns on the emergency retry. */
const RETRY_KEEP_USER_TURNS = 3;

export function isContextOverflowError(error: unknown): boolean {
  if (!error) return false;
  const blobs: string[] = [];
  const err = error as Record<string, unknown>;
  if (typeof err.message === "string") blobs.push(err.message);
  if (typeof err.responseBody === "string") blobs.push(err.responseBody);
  if (typeof err.data === "string") blobs.push(err.data);
  // AI SDK APICallError nests provider payloads under `data`/`responseBody`;
  // fall back to a defensive stringify of the whole error.
  try {
    blobs.push(JSON.stringify(error));
  } catch {
    blobs.push(String(error));
  }
  return blobs.some(b => OVERFLOW_PATTERNS.test(b));
}

type PromptMessage = { role: string; content: unknown };

/**
 * Trim a `ModelMessage[]` prompt to the last N user turns while keeping a valid
 * provider prompt: preserve leading `system` messages, ensure the first
 * non-system message is a `user` message (no orphan `tool` results, no leading
 * `assistant`), and never drop the trailing messages (the current question).
 */
export function trimPromptToRecentUserTurns(
  prompt: PromptMessage[],
  keepUserTurns: number = RETRY_KEEP_USER_TURNS,
): PromptMessage[] {
  const system = prompt.filter(m => m.role === "system");
  const rest = prompt.filter(m => m.role !== "system");

  // Find the start indices of user turns from the end.
  const userIdx: number[] = [];
  for (let i = 0; i < rest.length; i++) {
    if (rest[i].role === "user") userIdx.push(i);
  }
  if (userIdx.length === 0) return prompt; // nothing safe to do

  const startUser = userIdx[Math.max(0, userIdx.length - keepUserTurns)];
  const tail = rest.slice(startUser);
  return [...system, ...tail];
}

function withTrimmedPrompt<
  T extends { prompt?: unknown; providerOptions?: unknown },
>(params: T): T {
  const prompt = params.prompt;
  if (!Array.isArray(prompt)) return params;
  const trimmed = trimPromptToRecentUserTurns(prompt as PromptMessage[]);
  return { ...params, prompt: trimmed } as T;
}

export function withContextOverflowSelfHeal(
  model: LanguageModel,
  modelId: string,
): LanguageModel {
  const log = (originalCount: number, retriedCount: number) =>
    logger.warn(
      "Model rejected prompt as too long; retrying with trimmed history",
      {
        modelId,
        originalMessages: originalCount,
        retriedMessages: retriedCount,
      },
    );

  const middleware: LanguageModelMiddleware = {
    specificationVersion: "v3",
    wrapGenerate: async ({ doGenerate, params, model: inner }) => {
      try {
        return await doGenerate();
      } catch (error) {
        if (!isContextOverflowError(error)) throw error;
        const retried = withTrimmedPrompt(params);
        log(
          Array.isArray(params.prompt) ? params.prompt.length : -1,
          Array.isArray(retried.prompt) ? retried.prompt.length : -1,
        );
        return inner.doGenerate(retried);
      }
    },
    wrapStream: async ({ doStream, params, model: inner }) => {
      try {
        // Request-time 400: doStream() rejects before the first chunk, so a
        // whole-call retry emits no duplicate output.
        return await doStream();
      } catch (error) {
        if (!isContextOverflowError(error)) throw error;
        const retried = withTrimmedPrompt(params);
        log(
          Array.isArray(params.prompt) ? params.prompt.length : -1,
          Array.isArray(retried.prompt) ? retried.prompt.length : -1,
        );
        return inner.doStream(retried);
      }
    },
  };

  return wrapLanguageModel({
    model: model as Parameters<typeof wrapLanguageModel>[0]["model"],
    middleware,
  }) as unknown as LanguageModel;
}

/**
 * Structured handling for chat model stream errors.
 *
 * Why this exists: when the Vercel AI Gateway rejects a request for one
 * provider (e.g. expired BYOK credentials for zai/GLM or alibaba/Qwen while
 * Anthropic keeps working), the raw error that reaches the client is doubly
 * rewritten and loses everything useful:
 *
 *   1. `@ai-sdk/gateway` replaces the upstream `authentication_error` message
 *      with generic "Invalid API key" advice (createContextualError).
 *   2. `ai`'s wrapGatewayError replaces that again with "Unauthenticated.
 *      Configure AI_GATEWAY_API_KEY ..." — no model, no provider, no status.
 *
 * Meanwhile the server's only trace was the AI SDK's default
 * `console.error(error)` — unstructured, without chatId/model context, and
 * invisible to log-based alerting.
 *
 * `describeStreamError` extracts whatever survives (name, statusCode, gateway
 * generationId, cause chain) for structured logging, and
 * `buildClientStreamErrorPayload` emits the JSON `{ code, message, ... }`
 * envelope the frontend already recognizes as a terminal server error (see
 * useStreamResume.ts — structured errors skip the resume-retry loop).
 */

import { GatewayError, GatewayModelNotFoundError } from "@ai-sdk/gateway";

export interface DescribedStreamError {
  errorName: string;
  errorMessage: string;
  statusCode?: number;
  /** Vercel AI Gateway generation ID — correlates with the gateway dashboard. */
  generationId?: string;
  /** Gateway error taxonomy, e.g. "authentication_error". */
  gatewayErrorType?: string;
  /** Messages of nested `cause` errors, outermost first. */
  causeChain: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

/** Walk `error` and its `cause` chain (bounded, cycle-safe). */
function errorChain(error: unknown): unknown[] {
  const chain: unknown[] = [];
  const seen = new Set<unknown>();
  let current: unknown = error;
  while (current !== undefined && current !== null && !seen.has(current)) {
    seen.add(current);
    chain.push(current);
    if (chain.length >= 8) break;
    current = isRecord(current) ? current.cause : undefined;
  }
  return chain;
}

function messageOf(error: unknown): string {
  if (error instanceof Error) return error.message;
  if (isRecord(error) && typeof error.message === "string") {
    return error.message;
  }
  return String(error);
}

/**
 * Whether this error (or anything in its cause chain) is a gateway/provider
 * authentication failure. Matches both the real GatewayAuthenticationError
 * and the rewritten messages the AI SDK substitutes for it (which drop the
 * class, the cause, and the status code).
 */
export function isGatewayAuthError(error: unknown): boolean {
  return errorChain(error).some(err => {
    if (isRecord(err) && err.name === "GatewayAuthenticationError") {
      return true;
    }
    const msg = messageOf(err);
    return (
      msg.includes("AI Gateway authentication failed") ||
      msg.includes("Unauthenticated request to AI Gateway") ||
      // Production rewrite in ai's wrapGatewayError
      msg.startsWith("Unauthenticated. Configure AI_GATEWAY_API_KEY")
    );
  });
}

/** Extract a structured, log-friendly description of a stream error. */
export function describeStreamError(error: unknown): DescribedStreamError {
  const chain = errorChain(error);

  const described: DescribedStreamError = {
    errorName:
      error instanceof Error
        ? error.name
        : isRecord(error) && typeof error.name === "string"
          ? error.name
          : "UnknownError",
    errorMessage: messageOf(error),
    causeChain: chain.slice(1).map(messageOf),
  };

  for (const err of chain) {
    if (GatewayError.isInstance(err)) {
      described.statusCode ??= err.statusCode;
      described.generationId ??= err.generationId;
      described.gatewayErrorType ??= err.type;
      continue;
    }
    // APICallError and friends carry a statusCode too.
    if (
      described.statusCode === undefined &&
      isRecord(err) &&
      typeof err.statusCode === "number"
    ) {
      described.statusCode = err.statusCode;
    }
  }

  if (described.statusCode === undefined && isGatewayAuthError(error)) {
    described.statusCode = 401;
  }

  return described;
}

export type StreamErrorCode =
  | "model_auth_error"
  | "model_rate_limited"
  | "model_not_found"
  | "model_stream_error";

export interface ClientStreamErrorPayload {
  code: StreamErrorCode;
  message: string;
  modelId: string;
  statusCode?: number;
  generationId?: string;
}

/**
 * Map a stream error to the structured JSON string sent to the client as the
 * SSE error part. The frontend parses JSON errors with a `code` as terminal
 * server errors (no resume retries) and renders `message` directly.
 */
export function buildClientStreamErrorPayload(
  error: unknown,
  modelId: string,
): string {
  const described = describeStreamError(error);
  const provider = modelId.split("/")[0] || "the provider";

  let code: StreamErrorCode;
  let message: string;

  if (
    isGatewayAuthError(error) ||
    described.statusCode === 401 ||
    described.statusCode === 403
  ) {
    code = "model_auth_error";
    message =
      `The AI Gateway rejected the request for ${modelId} (unauthorized). ` +
      `This is a provider-level credential problem for "${provider}" — other providers may keep working. ` +
      `Check the gateway's API key and any BYOK credentials for "${provider}" in the Vercel AI Gateway dashboard.`;
  } else if (
    described.statusCode === 429 ||
    described.gatewayErrorType === "rate_limit_exceeded"
  ) {
    code = "model_rate_limited";
    message = `${modelId} is rate-limited right now. Wait a moment and retry, or switch models.`;
  } else if (
    errorChain(error).some(err => GatewayModelNotFoundError.isInstance(err))
  ) {
    code = "model_not_found";
    message = `${modelId} is not available on the AI Gateway. Pick a different model.`;
  } else {
    code = "model_stream_error";
    message = `${modelId} request failed: ${described.errorMessage}`;
  }

  const payload: ClientStreamErrorPayload = {
    code,
    message,
    modelId,
    ...(described.statusCode !== undefined
      ? { statusCode: described.statusCode }
      : {}),
    ...(described.generationId !== undefined
      ? { generationId: described.generationId }
      : {}),
  };
  return JSON.stringify(payload);
}

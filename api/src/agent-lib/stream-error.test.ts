/**
 * Tests for structured chat-stream error handling
 * (agent-lib/stream-error.ts).
 *
 * Covers gateway auth failures in all three shapes they reach us (real
 * GatewayAuthenticationError, the AI SDK's dev and production rewrites),
 * rate-limit / model-not-found mapping, generationId extraction, and the
 * generic fallback.
 *
 * Run: tsx src/agent-lib/stream-error.test.ts
 */
import assert from "node:assert/strict";
import {
  GatewayAuthenticationError,
  GatewayModelNotFoundError,
  GatewayRateLimitError,
} from "@ai-sdk/gateway";
import {
  buildClientStreamErrorPayload,
  describeStreamError,
  isGatewayAuthError,
} from "./stream-error";

function t(label: string, fn: () => void): void {
  fn();
  process.stdout.write(`ok  ${label}\n`);
}

t("describes a GatewayAuthenticationError with status + generationId", () => {
  const err = new GatewayAuthenticationError({
    message: "unauthorized",
    statusCode: 401,
    generationId: "gen_123",
  });
  const described = describeStreamError(err);
  assert.equal(described.errorName, "GatewayAuthenticationError");
  assert.equal(described.statusCode, 401);
  assert.equal(described.generationId, "gen_123");
  assert.equal(described.gatewayErrorType, "authentication_error");
});

t("finds gateway errors nested in the cause chain", () => {
  const inner = new GatewayRateLimitError({
    message: "slow down",
    statusCode: 429,
    generationId: "gen_rl",
  });
  const outer = new Error("wrapped", { cause: inner });
  const described = describeStreamError(outer);
  assert.equal(described.statusCode, 429);
  assert.equal(described.generationId, "gen_rl");
  // GatewayError appends the generation ID to its message.
  assert.deepEqual(described.causeChain, ["slow down [gen_rl]"]);
});

t("recognizes the AI SDK's dev rewrite of gateway auth errors", () => {
  const err = Object.assign(
    new Error("Unauthenticated request to AI Gateway.\n\nTo authenticate..."),
    { name: "GatewayAuthenticationError" },
  );
  assert.equal(isGatewayAuthError(err), true);
  assert.equal(describeStreamError(err).statusCode, 401);
});

t("recognizes the AI SDK's production rewrite of gateway auth errors", () => {
  const err = new Error(
    "Unauthenticated. Configure AI_GATEWAY_API_KEY or use a provider module. Learn more: https://ai-sdk.dev/unauthenticated-ai-gateway",
  );
  err.name = "GatewayError";
  assert.equal(isGatewayAuthError(err), true);
});

t("does not flag unrelated errors as auth errors", () => {
  assert.equal(isGatewayAuthError(new Error("connection reset")), false);
  assert.equal(isGatewayAuthError("string error"), false);
  assert.equal(isGatewayAuthError(undefined), false);
});

t("maps auth failures to model_auth_error with provider guidance", () => {
  const err = new GatewayAuthenticationError({
    message: "unauthorized",
    statusCode: 401,
    generationId: "gen_auth",
  });
  const payload = JSON.parse(buildClientStreamErrorPayload(err, "zai/glm-5"));
  assert.equal(payload.code, "model_auth_error");
  assert.equal(payload.modelId, "zai/glm-5");
  assert.equal(payload.statusCode, 401);
  assert.equal(payload.generationId, "gen_auth");
  assert.match(payload.message, /zai\/glm-5/);
  assert.match(payload.message, /"zai"/);
});

t("maps rate limits to model_rate_limited", () => {
  const err = new GatewayRateLimitError({ statusCode: 429 });
  const payload = JSON.parse(
    buildClientStreamErrorPayload(err, "alibaba/qwen3-max"),
  );
  assert.equal(payload.code, "model_rate_limited");
  assert.match(payload.message, /alibaba\/qwen3-max/);
});

t("maps missing models to model_not_found", () => {
  const err = new GatewayModelNotFoundError({
    message: "no such model",
    statusCode: 404,
  });
  const payload = JSON.parse(buildClientStreamErrorPayload(err, "zai/glm-99"));
  assert.equal(payload.code, "model_not_found");
});

t("falls back to model_stream_error with the original message", () => {
  const payload = JSON.parse(
    buildClientStreamErrorPayload(
      new Error("upstream exploded"),
      "openai/gpt-5.2",
    ),
  );
  assert.equal(payload.code, "model_stream_error");
  assert.match(payload.message, /upstream exploded/);
  assert.equal(payload.statusCode, undefined);
});

t("handles cyclic cause chains without hanging", () => {
  const a = new Error("a");
  const b = new Error("b", { cause: a });
  (a as { cause?: unknown }).cause = b;
  const described = describeStreamError(b);
  assert.equal(described.errorMessage, "b");
});

process.stdout.write("stream-error tests passed\n");

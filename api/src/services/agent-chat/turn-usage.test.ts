import assert from "node:assert/strict";
import type { UIMessage } from "ai";

import {
  aggregateStepUsage,
  totalsFromFinishUsage,
  totalsFromUsage,
} from "./turn-usage";
import {
  NO_CLIENT_TOOL_RESULT,
  findStrandedClientToolParts,
  patchStrandedToolParts,
} from "./stranded-turn";
import type { ChatTurn } from "./turn";

// ── usage aggregation ────────────────────────────────────────────────
{
  const { totals, stepDetails } = aggregateStepUsage(
    [
      {
        usage: {
          inputTokens: 100,
          outputTokens: 20,
          inputTokenDetails: { cacheReadTokens: 60, cacheWriteTokens: 5 },
          outputTokenDetails: { reasoningTokens: 7 },
        },
        response: { modelId: "anthropic/claude-x" },
      },
      // No usage: skipped entirely.
      { response: { modelId: "ignored" } },
      // OpenAI-style names, no response model → the fallback model.
      { usage: { promptTokens: 10, completionTokens: 3 } },
    ],
    "fallback/model",
  );
  assert.deepEqual(totals, {
    inputTokens: 110,
    outputTokens: 23,
    cacheReadTokens: 60,
    cacheWriteTokens: 5,
    reasoningTokens: 7,
  });
  assert.equal(stepDetails.length, 2);
  assert.equal(stepDetails[0].modelId, "anthropic/claude-x");
  assert.equal(stepDetails[1].modelId, "fallback/model");
  assert.equal(stepDetails[1].inputTokens, 10);
  assert.ok(stepDetails.every(s => s.costUsd === 0));
}

assert.deepEqual(totalsFromUsage(undefined), {
  inputTokens: 0,
  outputTokens: 0,
  cacheReadTokens: 0,
  cacheWriteTokens: 0,
  reasoningTokens: 0,
});
assert.deepEqual(
  totalsFromUsage({
    inputTokens: 4,
    outputTokens: 2,
    inputTokenDetails: { cacheReadTokens: 1 },
  }),
  {
    inputTokens: 4,
    outputTokens: 2,
    cacheReadTokens: 1,
    cacheWriteTokens: 0,
    reasoningTokens: 0,
  },
);
assert.deepEqual(
  totalsFromFinishUsage({
    inputTokens: 9,
    outputTokens: Number.NaN,
    outputTokenDetails: { reasoningTokens: 2 },
  }),
  {
    inputTokens: 9,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    reasoningTokens: 2,
  },
);

// ── stranded client-tool detection ───────────────────────────────────
{
  const tools = {
    capture_screenshot: {},
    run_query: { execute: () => undefined },
    submit_plan: {},
  } as unknown as ChatTurn["tools"];

  const assistant = (parts: unknown[]): UIMessage =>
    ({ id: "a", role: "assistant", parts }) as UIMessage;

  const pendingClient = {
    type: "tool-capture_screenshot",
    state: "input-available",
    toolCallId: "1",
  };
  const done = { type: "text", text: "hi" };

  const stranded = findStrandedClientToolParts(
    [assistant([done, pendingClient])],
    tools,
  );
  assert.ok(stranded, "a pending client-only tool strands the segment");
  assert.equal(stranded.pendingParts.length, 1);

  const patched = patchStrandedToolParts(
    [assistant([done, pendingClient])],
    stranded.lastMessage,
    stranded.pendingParts,
  );
  const patchedParts = patched[0].parts as Array<Record<string, unknown>>;
  assert.equal(patchedParts[0], done);
  assert.equal(patchedParts[1].state, "output-available");
  assert.equal(patchedParts[1].output, NO_CLIENT_TOOL_RESULT);

  // A server-executed tool, a human-in-the-loop tool, an unknown tool or a
  // user last message is never stranded.
  for (const part of [
    { type: "tool-run_query", state: "input-available" },
    { type: "tool-submit_plan", state: "input-available" },
    { type: "dynamic-tool", toolName: "nope", state: "input-available" },
  ]) {
    assert.equal(
      findStrandedClientToolParts([assistant([pendingClient, part])], tools),
      null,
    );
  }
  assert.equal(
    findStrandedClientToolParts(
      [{ id: "u", role: "user", parts: [] } as UIMessage],
      tools,
    ),
    null,
  );
  assert.equal(findStrandedClientToolParts([assistant([done])], tools), null);
}

console.info("agent-chat turn-usage + stranded-turn tests passed");

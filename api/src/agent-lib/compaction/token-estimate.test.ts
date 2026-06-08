import assert from "node:assert/strict";
import type { ModelMessage } from "ai";
import {
  CHARS_PER_TOKEN,
  estimateTokensFromChars,
  estimateTokensFromText,
  serializedCharSize,
  modelMessageCharSize,
  estimateModelMessagesTokens,
  pickUsageSignal,
} from "./token-estimate";

function t(label: string, fn: () => void) {
  fn();
  process.stdout.write(`ok  ${label}\n`);
}

t("chars/4 heuristic rounds up", () => {
  assert.equal(estimateTokensFromChars(40), 10);
  assert.equal(estimateTokensFromChars(41), 11);
  assert.equal(estimateTokensFromChars(0), 0);
  assert.equal(estimateTokensFromChars(-5), 0);
  assert.equal(CHARS_PER_TOKEN, 4);
});

t("estimateTokensFromText measures string length", () => {
  assert.equal(estimateTokensFromText("a".repeat(40)), 10);
  assert.equal(estimateTokensFromText(""), 0);
});

t("serializedCharSize handles strings, objects, nullish", () => {
  assert.equal(serializedCharSize("hello"), 5);
  assert.equal(serializedCharSize(null), 0);
  assert.equal(serializedCharSize(undefined), 0);
  assert.equal(serializedCharSize({ a: 1 }), JSON.stringify({ a: 1 }).length);
});

t("modelMessageCharSize counts string and structured content", () => {
  const stringMsg: ModelMessage = { role: "user", content: "hi there" };
  assert.equal(modelMessageCharSize(stringMsg), 8);

  const toolMsg = {
    role: "tool",
    content: [
      { type: "tool-result", toolCallId: "c1", toolName: "x", output: { type: "json", value: { n: 1 } } },
    ],
  } as unknown as ModelMessage;
  assert.equal(
    modelMessageCharSize(toolMsg),
    JSON.stringify((toolMsg as { content: unknown }).content).length,
  );
});

t("estimateModelMessagesTokens sums message content", () => {
  const messages: ModelMessage[] = [
    { role: "user", content: "a".repeat(40) },
    { role: "assistant", content: "b".repeat(40) },
  ];
  assert.equal(estimateModelMessagesTokens(messages), 20);
});

t("pickUsageSignal prefers reported usage when present", () => {
  const messages: ModelMessage[] = [{ role: "user", content: "a".repeat(40) }];
  const withUsage = pickUsageSignal({ priorInputTokens: 1234, messages });
  assert.equal(withUsage.source, "usage");
  assert.equal(withUsage.tokens, 1234);
});

t("pickUsageSignal falls back to estimate + system tokens", () => {
  const messages: ModelMessage[] = [{ role: "user", content: "a".repeat(40) }];
  const est = pickUsageSignal({ priorInputTokens: 0, messages, systemTokens: 5 });
  assert.equal(est.source, "estimate");
  assert.equal(est.tokens, 5 + 10);
});

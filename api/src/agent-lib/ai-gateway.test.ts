import assert from "node:assert/strict";
import { buildPromptCacheHeaders, buildProviderOptions } from "./ai-gateway";

function t(label: string, fn: () => void) {
  fn();
  process.stdout.write(`ok  ${label}\n`);
}

const base = {
  userId: "user-1",
  workspaceId: "ws-1",
  agentId: "unified",
  invocationType: "chat",
};

t("no cache session → gateway metadata only, no caching", () => {
  assert.deepEqual(buildProviderOptions(base), {
    gateway: {
      user: "user-1",
      tags: ["ws:ws-1", "agent:unified", "type:chat"],
    },
  });
});

t("cache session → gateway auto caching + OpenAI cache key", () => {
  const opts = buildProviderOptions({
    ...base,
    promptCacheSessionId: "chat-42",
  });
  assert.equal(opts.gateway.caching, "auto");
  assert.equal(opts.gateway.user, "user-1");
  assert.deepEqual(opts.gateway.tags, [
    "ws:ws-1",
    "agent:unified",
    "type:chat",
  ]);
  assert.deepEqual(opts.openai, { promptCacheKey: "chat-42" });
});

t("cache session leaves room for the caller's anthropic options", () => {
  const opts = buildProviderOptions({
    ...base,
    promptCacheSessionId: "chat-42",
  });
  assert.equal(opts.anthropic, undefined);
});

t("prompt cache headers carry the session affinity id", () => {
  assert.deepEqual(buildPromptCacheHeaders("chat-42"), {
    "x-session-affinity": "chat-42",
  });
});

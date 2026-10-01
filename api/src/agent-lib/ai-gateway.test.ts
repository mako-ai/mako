/**
 * Spend attribution on gateway calls.
 *
 * Vercel's Custom Reporting groups the bill by `user` and by `tag`, and the
 * workspace connector's `usage-by-tag` / `usage-by-user` entities land those
 * groupings in the warehouse. A request without them is a row with an empty
 * tag that nobody can explain, so every helper here must always emit a
 * `type:` tag and a user — falling back to `system` — and stay inside
 * Vercel's limits (≤10 tags of 1–64 chars, user ≤256 chars).
 *
 * Run: tsx src/agent-lib/ai-gateway.test.ts
 */
import assert from "node:assert/strict";
import {
  SYSTEM_ATTRIBUTION_USER,
  buildProviderOptions,
  gatewayAttributionOptions,
  systemProviderOptions,
} from "./ai-gateway";

const WS = "6846e6a01b05af0948070582";

// A person, in a workspace, through an agent: the chat path.
assert.deepEqual(
  buildProviderOptions({
    userId: "u1",
    workspaceId: WS,
    agentId: "unified",
    invocationType: "chat",
  }),
  {
    gateway: {
      user: "u1",
      tags: [`ws:${WS}`, "agent:unified", "type:chat"],
    },
  },
);

// The pre-existing callers omit invocationType: it must still be tagged.
assert.deepEqual(buildProviderOptions({ userId: "u1", workspaceId: WS }), {
  gateway: { user: "u1", tags: [`ws:${WS}`, "type:chat"] },
});

// Nobody in particular: a model probe, an index rebuild.
assert.deepEqual(systemProviderOptions("model_probe"), {
  gateway: { user: SYSTEM_ATTRIBUTION_USER, tags: ["type:model_probe"] },
});
assert.deepEqual(systemProviderOptions("embedding", WS), {
  gateway: {
    user: SYSTEM_ATTRIBUTION_USER,
    tags: [`ws:${WS}`, "type:embedding"],
  },
});

// An empty user id is not a user.
assert.equal(
  gatewayAttributionOptions({ userId: "", invocationType: "embedding" }).user,
  SYSTEM_ATTRIBUTION_USER,
);

// Vercel's limits hold for every shape the helpers can produce.
for (const options of [
  buildProviderOptions({
    userId: "u".repeat(200),
    workspaceId: WS,
    agentId: "a".repeat(40),
    invocationType: "description_generation",
  }).gateway,
  systemProviderOptions("compaction", WS).gateway,
]) {
  assert.ok(options.tags.length <= 10);
  for (const tag of options.tags) {
    assert.ok(tag.length >= 1 && tag.length <= 64, tag);
  }
  assert.ok(options.user.length <= 256);
}

console.log("ai-gateway attribution: ok");

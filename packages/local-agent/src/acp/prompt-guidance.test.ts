import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { applyNonClaudeGuidanceToPrompt } from "./prompt-guidance";

describe("applyNonClaudeGuidanceToPrompt", () => {
  it("injects full guidance on the first Codex turn", () => {
    const result = applyNonClaudeGuidanceToPrompt({
      userText: "hello",
      guidanceAppend: "Use mako-workspace tools",
      alreadyInjected: false,
    });
    assert.equal(result.injectedFull, true);
    assert.match(result.text, /Mako workspace system guidance/);
    assert.match(result.text, /Use mako-workspace tools/);
    assert.match(result.text, /hello$/);
  });

  it("injects a short reminder on later Codex turns", () => {
    const result = applyNonClaudeGuidanceToPrompt({
      userText: "next",
      guidanceAppend: "Use mako-workspace tools",
      alreadyInjected: true,
    });
    assert.equal(result.injectedReminder, true);
    assert.match(result.text, /Mako reminder/);
    assert.match(result.text, /read_self_directive/);
    assert.doesNotMatch(result.text, /Use mako-workspace tools/);
  });
});

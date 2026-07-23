import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { buildMakoSystemPromptAppend } from "./mako-system-append";

describe("buildMakoSystemPromptAppend", () => {
  it("mentions MCP tools and skills without stuffing full skill bodies", () => {
    const text = buildMakoSystemPromptAppend({
      mcpServerName: "mako-workspace",
    });
    assert.match(text, /mako-workspace/);
    assert.match(text, /get_relevant_skills/);
    assert.match(text, /claude mcp/);
    assert.match(text, /Desktop Chat/);
    assert.match(text, /create_preview_token/);
    assert.match(text, /Do \*\*not\*\* call/);
    assert.ok(text.length < 3500);
  });

  it("appends workspace guidance when provided", () => {
    const text = buildMakoSystemPromptAppend({
      mcpServerName: "mako-workspace",
      extraAppend: "Revenue is booked in Wise.",
    });
    assert.match(text, /Workspace guidance/);
    assert.match(text, /Wise/);
  });
});

import { describe, expect, it } from "vitest";
import type { UIMessage } from "ai";
import {
  buildAcpContinuitySeed,
  prependAcpPromptLayers,
} from "./acp-continuity";

function msg(
  role: "user" | "assistant",
  text: string,
  extraParts: UIMessage["parts"] = [],
): UIMessage {
  return {
    id: `${role}-${text.slice(0, 8)}`,
    role,
    parts: [{ type: "text", text }, ...extraParts],
  };
}

describe("buildAcpContinuitySeed", () => {
  it("returns empty for no messages", () => {
    expect(buildAcpContinuitySeed([])).toBe("");
  });

  it("summarizes prior turns for a fresh ACP session", () => {
    const seed = buildAcpContinuitySeed([
      msg("user", "make a chart"),
      msg("assistant", "done"),
    ]);
    expect(seed).toContain("Prior Mako chat transcript");
    expect(seed).toContain("user: make a chart");
    expect(seed).toContain("assistant: done");
    expect(seed).toContain("[End prior transcript]");
  });
});

describe("prependAcpPromptLayers", () => {
  it("keeps raw user text when no layers", () => {
    expect(prependAcpPromptLayers({ userText: " hi " })).toBe("hi");
  });

  it("stacks continuity + UI context above the user message", () => {
    const out = prependAcpPromptLayers({
      userText: "fix it",
      continuitySeed: "[prior]",
      uiContext: "[ui]",
    });
    expect(out).toContain("[prior]");
    expect(out).toContain("[ui]");
    expect(out).toContain("[User message]\nfix it");
  });
});

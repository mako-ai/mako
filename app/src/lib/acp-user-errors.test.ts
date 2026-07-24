import { describe, expect, it } from "vitest";
import {
  isAcpAdapterNoise,
  sanitizeAcpUserError,
  shouldClearAcpAuthGuidance,
} from "./acp-user-errors";

describe("acp-user-errors", () => {
  it("filters Claude SDK canUseTool shadow dumps", () => {
    const dump =
      "Invalid params\n(node:1) [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked";
    expect(isAcpAdapterNoise(dump)).toBe(true);
    expect(sanitizeAcpUserError(dump, { providerId: "codex" })).toMatch(
      /Terra/i,
    );
  });

  it("clears Terminal guidance when already signed in", () => {
    expect(
      shouldClearAcpAuthGuidance(
        "Complete sign-in in the Terminal window that just opened",
        { cliLoggedIn: true, connected: true },
      ),
    ).toBe(true);
    expect(
      shouldClearAcpAuthGuidance(
        "Complete sign-in in the Terminal window that just opened",
        { cliLoggedIn: false, connected: false, authRequired: true },
      ),
    ).toBe(false);
  });
});

import { describe, expect, it } from "vitest";
import { rewriteLocalAgentNotFound } from "./acp-client";

describe("rewriteLocalAgentNotFound", () => {
  it("rewrites bare Not Found and HTTP 404", () => {
    expect(rewriteLocalAgentNotFound("Not Found")).toMatch(/Desktop 0\.3\.9/);
    expect(rewriteLocalAgentNotFound("Agent error (HTTP 404)")).toMatch(
      /outdated/,
    );
    expect(rewriteLocalAgentNotFound("Failed (Not Found)")).toMatch(
      /fully quit/i,
    );
  });

  it("leaves other errors unchanged", () => {
    expect(rewriteLocalAgentNotFound("ACP connection closed")).toBe(
      "ACP connection closed",
    );
  });
});

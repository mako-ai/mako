import { describe, expect, it } from "vitest";
import { prependAcpUiContext } from "./acp-ui-context";

describe("prependAcpUiContext", () => {
  it("prepends context above the user message", () => {
    expect(prependAcpUiContext("hello", "[ctx]")).toBe(
      "[ctx]\n\n[User message]\nhello",
    );
  });
});

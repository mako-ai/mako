// @vitest-environment node
import { describe, expect, it } from "vitest";
import { isAcpConnectionClosedError } from "./acp-connection-errors";

describe("isAcpConnectionClosedError", () => {
  it("matches recoverable ACP failures", () => {
    expect(isAcpConnectionClosedError(new Error("ACP connection closed"))).toBe(
      true,
    );
    expect(
      isAcpConnectionClosedError(
        new Error("Claude Code connection dropped (adapter process exited)"),
      ),
    ).toBe(true);
    expect(
      isAcpConnectionClosedError(
        new Error(
          "Unknown or expired ACP session: abc. Send again to reconnect.",
        ),
      ),
    ).toBe(true);
  });

  it("ignores unrelated errors", () => {
    expect(isAcpConnectionClosedError(new Error("Mako MCP auth failed"))).toBe(
      false,
    );
  });
});

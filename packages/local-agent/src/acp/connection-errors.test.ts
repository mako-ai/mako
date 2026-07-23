import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acpReconnectMessage,
  isAcpConnectionClosedError,
} from "./connection-errors";

describe("isAcpConnectionClosedError", () => {
  it("matches SDK close errors", () => {
    assert.equal(
      isAcpConnectionClosedError(new Error("ACP connection closed")),
      true,
    );
    assert.equal(isAcpConnectionClosedError("connection closed"), true);
    assert.equal(isAcpConnectionClosedError(new Error("EPIPE")), true);
  });

  it("ignores unrelated errors", () => {
    assert.equal(isAcpConnectionClosedError(new Error("auth failed")), false);
  });
});

describe("acpReconnectMessage", () => {
  it("mentions reconnect", () => {
    assert.match(acpReconnectMessage("Claude Code"), /fresh local session/i);
  });
});

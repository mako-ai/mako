import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acpReconnectMessage,
  explainAdapterLaunchFailure,
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

describe("explainAdapterLaunchFailure", () => {
  it("explains ENOTEMPTY npx cache failures", () => {
    const tip = explainAdapterLaunchFailure(
      "npm error code ENOTEMPTY\nnpm error ENOTEMPTY: directory not empty, rename /Users/x/.npm/_npx/abc",
    );
    assert.ok(tip);
    assert.match(tip, /rm -rf ~\/\.npm\/_npx/);
    assert.match(tip, /npm i -g @agentclientprotocol\/claude-agent-acp/);
  });
});

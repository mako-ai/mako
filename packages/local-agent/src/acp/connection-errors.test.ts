import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  acpReconnectMessage,
  explainAdapterLaunchFailure,
  isAcpConnectionClosedError,
  isAdapterStderrNoise,
  sanitizeAdapterStderrForUi,
  userFacingAcpError,
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

describe("adapter stderr noise", () => {
  it("filters Claude canUseTool shadow warnings", () => {
    const dump =
      "Invalid params\n" +
      "(node:123) [CLAUDE_SDK_CAN_USE_TOOL_SHADOWED] Warning: canUseTool will not be invoked for: mcp__mako-workspace__*";
    assert.equal(isAdapterStderrNoise(dump), true);
    assert.equal(sanitizeAdapterStderrForUi(dump), null);
    assert.match(
      userFacingAcpError(dump, { providerId: "codex" }),
      /Terra|Enable workspace tools/i,
    );
  });

  it("keeps actionable adapter failures", () => {
    const text = "ENOTEMPTY: directory not empty, rename /Users/x/.npm/_npx/abc";
    assert.equal(isAdapterStderrNoise(text), false);
    assert.ok(sanitizeAdapterStderrForUi(text));
  });
});

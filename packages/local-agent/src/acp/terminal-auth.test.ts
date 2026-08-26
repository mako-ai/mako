import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  defaultTerminalLoginLaunch,
  extractTerminalAuthLaunch,
  formatTerminalAuthCommand,
} from "./terminal-auth";

describe("extractTerminalAuthLaunch", () => {
  it("prefers terminal-auth meta", () => {
    const launch = extractTerminalAuthLaunch({
      id: "claude-ai-login",
      type: "terminal",
      _meta: {
        "terminal-auth": {
          command: "/usr/bin/node",
          args: ["acp.js", "--cli", "auth", "login", "--claudeai"],
          label: "Claude Login",
        },
      },
    });
    assert.ok(launch);
    assert.equal(launch.command, "/usr/bin/node");
    assert.deepEqual(launch.args.slice(-2), ["login", "--claudeai"]);
  });

  it("falls back for claude-ai-login without meta", () => {
    const launch = extractTerminalAuthLaunch({
      id: "claude-ai-login",
      type: "terminal",
    });
    assert.ok(launch);
    assert.match(formatTerminalAuthCommand(launch), /claudeai/);
  });
});

describe("defaultTerminalLoginLaunch", () => {
  it("uses provider CLI logins", () => {
    assert.equal(
      formatTerminalAuthCommand(defaultTerminalLoginLaunch("codex")),
      "codex login",
    );
    assert.equal(
      formatTerminalAuthCommand(defaultTerminalLoginLaunch("cursor")),
      "cursor-agent login",
    );
    assert.match(
      formatTerminalAuthCommand(defaultTerminalLoginLaunch("claude")),
      /claude-agent-acp/,
    );
  });
});

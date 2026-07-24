import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  parseCodexLoginStatusOutput,
  shouldAutoAuthenticateOnSessionNew,
} from "./codex-login-status";

describe("parseCodexLoginStatusOutput", () => {
  it("detects logged in", () => {
    assert.equal(
      parseCodexLoginStatusOutput("Logged in using ChatGPT\n"),
      true,
    );
  });

  it("detects not logged in", () => {
    assert.equal(parseCodexLoginStatusOutput("Not logged in\n"), false);
  });
});

describe("shouldAutoAuthenticateOnSessionNew", () => {
  it("never auto-auths Codex (avoids wiping auth.json via codex login)", () => {
    assert.equal(
      shouldAutoAuthenticateOnSessionNew({
        providerId: "codex",
        authRequired: true,
        authenticated: false,
        authMethods: [
          { type: "api-key" },
          { type: "oauth" },
        ],
      }),
      false,
    );
  });

  it("skips Claude terminal-only methods", () => {
    assert.equal(
      shouldAutoAuthenticateOnSessionNew({
        providerId: "claude",
        authRequired: true,
        authenticated: false,
        authMethods: [{ type: "terminal" }],
      }),
      false,
    );
  });

  it("allows non-terminal providers that still need RPC auth", () => {
    assert.equal(
      shouldAutoAuthenticateOnSessionNew({
        providerId: "claude",
        authRequired: true,
        authenticated: false,
        authMethods: [{ type: "api-key" }],
      }),
      true,
    );
  });

  it("skips when already authenticated", () => {
    assert.equal(
      shouldAutoAuthenticateOnSessionNew({
        providerId: "claude",
        authRequired: true,
        authenticated: true,
        authMethods: [{ type: "api-key" }],
      }),
      false,
    );
  });
});

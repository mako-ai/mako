import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  classifyEnsureFailure,
  packagesForProvider,
  shouldSkipEnsure,
} from "./ensure-adapter";

describe("ensure-adapter", () => {
  it("installs Codex CLI + codex-acp together", () => {
    assert.deepEqual(packagesForProvider("codex"), [
      "@openai/codex",
      "@agentclientprotocol/codex-acp",
    ]);
    assert.deepEqual(packagesForProvider("claude"), [
      "@agentclientprotocol/claude-agent-acp",
    ]);
  });

  it("classifies npm ensure failures", () => {
    assert.equal(
      classifyEnsureFailure({
        message: "npm not found on PATH",
        code: 1,
        adapterFound: false,
      }),
      "npm_missing",
    );
    assert.equal(
      classifyEnsureFailure({
        message: "fail",
        code: null,
        stderr: "npm install timed out after 3 minutes",
        adapterFound: false,
      }),
      "timeout",
    );
    assert.equal(
      classifyEnsureFailure({
        message: "fail",
        code: 1,
        stderr: "npm ERR! code EACCES",
        adapterFound: false,
      }),
      "eacces",
    );
  });

  it("skips only when a recent path install exists", () => {
    const now = Date.parse("2026-07-23T12:00:00.000Z");
    assert.equal(
      shouldSkipEnsure({
        force: false,
        lastSuccessAt: "2026-07-23T11:00:00.000Z",
        adapterVia: "path",
        now,
      }),
      true,
    );
    assert.equal(
      shouldSkipEnsure({
        force: false,
        lastSuccessAt: "2026-07-23T11:00:00.000Z",
        adapterVia: "npx",
        now,
      }),
      false,
      "npx fallback should trigger a global ensure",
    );
    assert.equal(
      shouldSkipEnsure({
        force: true,
        lastSuccessAt: "2026-07-23T11:00:00.000Z",
        adapterVia: "path",
        now,
      }),
      false,
    );
    assert.equal(
      shouldSkipEnsure({
        force: false,
        lastSuccessAt: "2026-07-22T00:00:00.000Z",
        adapterVia: "path",
        now,
      }),
      false,
      "stale ensure should run again",
    );
  });
});

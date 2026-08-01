import { describe, it } from "node:test";
import assert from "node:assert/strict";

import {
  clampRunAppTimeoutMs,
  isRunAppResult,
  runAppResultToMcpContent,
  summarizeRunAppResult,
  RUN_APP_DEFAULT_TIMEOUT_MS,
  RUN_APP_MAX_TIMEOUT_MS,
  RUN_APP_MIN_TIMEOUT_MS,
  type RunAppResult,
} from "./run-app";

const ready: RunAppResult = {
  success: true,
  status: "ready",
  errors: [],
  consoleLogs: ["[mako-preview-ready]"],
  source: "headless",
  screenshot: { mimeType: "image/jpeg", base64: "c2NyZWVuc2hvdA==" },
};

describe("run-app shared contract", () => {
  it("clamps the settle timeout to the shared range", () => {
    assert.equal(clampRunAppTimeoutMs(undefined), RUN_APP_DEFAULT_TIMEOUT_MS);
    assert.equal(clampRunAppTimeoutMs(1), RUN_APP_MIN_TIMEOUT_MS);
    assert.equal(clampRunAppTimeoutMs(999_999), RUN_APP_MAX_TIMEOUT_MS);
    assert.equal(clampRunAppTimeoutMs(30_000), 30_000);
  });

  it("summarize strips the screenshot but keeps everything else", () => {
    const summary = summarizeRunAppResult(ready);
    assert.equal("screenshot" in summary, false);
    assert.equal(summary.status, "ready");
    assert.deepEqual(summary.consoleLogs, ["[mako-preview-ready]"]);
  });

  it("formats a screenshot result as text + image MCP content", () => {
    const content = runAppResultToMcpContent(ready);
    assert.equal(content.length, 2);
    assert.equal(content[0].type, "text");
    const text = (content[0] as { text: string }).text;
    assert.match(text, /"status":"ready"/);
    // Base64 must never leak into the text part.
    assert.doesNotMatch(text, /c2NyZWVuc2hvdA==/);
    assert.deepEqual(content[1], {
      type: "image",
      data: "c2NyZWVuc2hvdA==",
      mimeType: "image/jpeg",
    });
  });

  it("formats a screenshot-less result as a single text part", () => {
    const { screenshot: _screenshot, ...noShot } = ready;
    const content = runAppResultToMcpContent({
      ...noShot,
      screenshotUnavailableReason: "renderer disabled",
    });
    assert.equal(content.length, 1);
    assert.match(
      (content[0] as { text: string }).text,
      /renderer disabled/,
    );
  });

  it("guards envelopes crossing loose boundaries", () => {
    assert.equal(isRunAppResult(ready), true);
    assert.equal(isRunAppResult({ success: true, errors: [] }), false);
    assert.equal(isRunAppResult(null), false);
    assert.equal(isRunAppResult("ok"), false);
    assert.equal(
      isRunAppResult({
        success: true,
        status: "ready",
        errors: [],
        source: "iframe",
      }),
      true,
    );
  });
});

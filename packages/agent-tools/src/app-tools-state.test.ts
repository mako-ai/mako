import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
  APP_PREVIEW_ERROR_CHARS,
  APP_PREVIEW_ERROR_MAX,
  APP_RESOURCE_MAX_CHARS,
  APP_STATE_CODE_PREVIEW_CHARS,
  appBindingResourceVersion,
  appResourceVersion,
  appVersionedResourceVersion,
  clipAgentText,
  readAppResourceRange,
  searchAppResources,
  summarizeAppBindingForState,
  summarizePreviewErrors,
} from "./app-tools";

describe("summarizeAppBindingForState", () => {
  it("keeps short code fully in preview", () => {
    const row = summarizeAppBindingForState({
      name: "mrr",
      language: "sql",
      code: "select 1",
    });
    assert.equal(row.codeLength, 8);
    assert.equal(row.codePreview, "select 1");
    assert.equal(row.materialization, "live");
  });

  it("truncates large SQL so get_app_state stays cheap", () => {
    const code = "x".repeat(APP_STATE_CODE_PREVIEW_CHARS + 5000);
    const row = summarizeAppBindingForState({
      name: "huge",
      connectionId: "c1",
      language: "sql",
      materialization: "parquet",
      code,
    });
    assert.equal(row.codeLength, code.length);
    assert.equal(row.codePreview.length, APP_STATE_CODE_PREVIEW_CHARS + 1);
    assert.ok(row.codePreview.endsWith("…"));
    assert.equal(row.codePreview.includes(code), false);
  });
});

describe("clipAgentText / summarizePreviewErrors", () => {
  it("clips full-read payloads with truncated flag", () => {
    const code = "y".repeat(APP_RESOURCE_MAX_CHARS + 100);
    const clipped = clipAgentText(code, APP_RESOURCE_MAX_CHARS);
    assert.equal(clipped.truncated, true);
    assert.equal(clipped.length, code.length);
    assert.ok(clipped.text.includes("…(truncated)"));
    assert.ok(clipped.text.length < code.length);
  });

  it("caps preview error count and message length", () => {
    const errors = Array.from({ length: APP_PREVIEW_ERROR_MAX + 5 }, (_, i) => ({
      message: `${"e".repeat(APP_PREVIEW_ERROR_CHARS + 50)}_${i}`,
      source: "runtime" as const,
    }));
    const summarized = summarizePreviewErrors(errors);
    assert.equal(summarized.length, APP_PREVIEW_ERROR_MAX);
    assert.ok(summarized[0]?.message.includes("…(truncated)"));
  });
});

describe("app resource protocol", () => {
  it("reads bounded line ranges with continuation metadata", () => {
    const text = Array.from({ length: 500 }, (_, i) => `line ${i + 1}`).join(
      "\n",
    );
    const range = readAppResourceRange(text, 10, 450);
    assert.equal(range.startLine, 10);
    assert.equal(range.endLine, 409);
    assert.equal(range.totalLines, 500);
    assert.equal(range.hasMore, true);
    assert.equal(range.nextStartLine, 410);
    assert.equal(range.contentTruncated, true);
    assert.match(range.content, /^line 10/);
  });

  it("does not mark a normal EOF as truncated", () => {
    const range = readAppResourceRange("one\ntwo", 1);
    assert.equal(range.content, "one\ntwo");
    assert.equal(range.hasMore, false);
    assert.equal(range.contentTruncated, false);
  });

  it("supports character continuation for oversized single lines", () => {
    const text = "x".repeat(APP_RESOURCE_MAX_CHARS + 50);
    const first = readAppResourceRange(text);
    assert.equal(first.content.length, APP_RESOURCE_MAX_CHARS);
    assert.equal(first.nextOffset, APP_RESOURCE_MAX_CHARS);
    assert.equal(first.nextStartLine, undefined);
    const second = readAppResourceRange(
      text,
      undefined,
      undefined,
      first.nextOffset,
    );
    assert.equal(second.content.length, 50);
    assert.equal(second.hasMore, false);
  });

  it("searches without returning whole resources", () => {
    const text = ["before", "needle here", "after", "far away"].join("\n");
    const result = searchAppResources(
      [
        {
          resource: "file:src/App.tsx",
          kind: "file",
          name: "src/App.tsx",
          text,
        },
      ],
      "NEEDLE",
      { contextLines: 1 },
    );
    assert.equal(result.matches.length, 1);
    assert.equal(result.matches[0]?.line, 2);
    assert.equal(result.matches[0]?.snippet, "before\nneedle here\nafter");
    assert.equal(
      result.matches[0]?.resourceVersion,
      appResourceVersion(text),
    );
  });

  it("changes the concurrency token when content changes", () => {
    assert.notEqual(appResourceVersion("select 1"), appResourceVersion("select 2"));
    assert.notEqual(
      appBindingResourceVersion({ code: "select 1", connectionId: "a" }),
      appBindingResourceVersion({ code: "select 1", connectionId: "b" }),
    );
    assert.notEqual(
      appVersionedResourceVersion(1, "same-hash"),
      appVersionedResourceVersion(2, "same-hash"),
    );
  });

  it("paginates search matches deterministically", () => {
    const result = searchAppResources(
      [
        {
          resource: "file:a.ts",
          kind: "file",
          name: "a.ts",
          text: "needle\nneedle\nneedle",
        },
      ],
      "needle",
      { contextLines: 0, maxResults: 1 },
    );
    assert.equal(result.matches[0]?.line, 1);
    assert.equal(result.nextOffset, 1);
    const next = searchAppResources(
      [
        {
          resource: "file:a.ts",
          kind: "file",
          name: "a.ts",
          text: "needle\nneedle\nneedle",
        },
      ],
      "needle",
      { contextLines: 0, maxResults: 1, offset: result.nextOffset },
    );
    assert.equal(next.matches[0]?.line, 2);
  });

  it("keeps the match visible in an oversized line snippet", () => {
    const prefix = "x".repeat(10_000);
    const result = searchAppResources(
      [
        {
          resource: "file:generated.js",
          kind: "file",
          name: "generated.js",
          text: `${prefix}UNIQUE_NEEDLE${prefix}`,
        },
      ],
      "unique_needle",
    );
    assert.match(result.matches[0]?.snippet ?? "", /UNIQUE_NEEDLE/);
  });
});

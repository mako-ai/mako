import assert from "node:assert/strict";
import { test } from "node:test";
import { interpretArtifactHeaders } from "./index.js";

test("interpretArtifactHeaders: stale + started means the SDK should watch", () => {
  const info = interpretArtifactHeaders(
    new Headers({
      "x-mako-artifact-built-at": "2026-09-08T10:00:00.000Z",
      "x-mako-artifact-stale": "1",
      "x-mako-rebuild": "started",
    }),
  );
  assert.equal(info.builtAt, "2026-09-08T10:00:00.000Z");
  assert.equal(info.stale, true);
  assert.equal(info.rebuild, "started");
  assert.equal(info.watch, true);
});

test("interpretArtifactHeaders: a current artifact is not watched", () => {
  const info = interpretArtifactHeaders({
    "x-mako-artifact-built-at": "2026-09-08T11:30:00.000Z",
    "x-mako-rebuild": "none",
  });
  assert.equal(info.stale, false);
  assert.equal(info.watch, false);
  assert.equal(info.rebuild, "none");
});

test("interpretArtifactHeaders: stale with no rebuild in flight is not watched", () => {
  const info = interpretArtifactHeaders({
    "X-Mako-Artifact-Stale": "1",
    "X-Mako-Rebuild": "none",
  });
  assert.equal(info.stale, true);
  assert.equal(info.watch, false);
});

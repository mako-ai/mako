/**
 * The preset icon route must find its SVG whatever the working directory.
 *
 * It resolved `../mcp/icons` from the route's own folder. From the built
 * `dist/routes/mcp` that lands on `dist/routes/mcp/icons`, which does not
 * exist, so production answered 404 and the app drew a plug icon. The test
 * moves the cwd to a folder with no `src/` to rule out the old cwd fallback.
 */
import assert from "node:assert/strict";
import os from "node:os";
import { test } from "node:test";
import { mcpPresetRoutes } from "./presets";

void test("the preset icon route serves slack.svg with 200 and an SVG type", async () => {
  const previousCwd = process.cwd();
  process.chdir(os.tmpdir());
  try {
    const res = await mcpPresetRoutes.request("/presets/slack/icon.svg");
    assert.equal(res.status, 200);
    assert.match(res.headers.get("content-type") ?? "", /image\/svg\+xml/);
    assert.match(await res.text(), /<svg/);
  } finally {
    process.chdir(previousCwd);
  }
});

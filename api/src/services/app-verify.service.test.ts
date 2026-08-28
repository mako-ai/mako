/**
 * Headless app-verify service tests: input validation before any I/O, the
 * renderer-disabled degradation path, and render-pool size resolution.
 * (App-existence and live-render paths need Mongo + Chromium and are
 * exercised by the MCP server integration tests.)
 *
 * Run: tsx src/services/app-verify.service.test.ts
 */
import assert from "node:assert/strict";

process.env.SESSION_SECRET =
  process.env.SESSION_SECRET ?? "test-secret-for-app-verify";
delete process.env.RENDER_APP_BROWSER_PATH;

import {
  renderAppPreview,
  resolveMaxConcurrentRenders,
} from "./app-render.service";
import { clientBaseUrl, verifyAppHeadless } from "./app-verify.service";

async function main() {
  // Invalid app id fails fast — before any DB lookup, token mint, or render.
  {
    const result = await verifyAppHeadless("6588f0f0f0f0f0f0f0f0f0f0", {
      appId: "not-an-object-id",
    });
    assert.equal(result.success, false);
    assert.equal(result.status, "error");
    assert.equal(result.source, "headless");
    assert.match(result.error ?? "", /Invalid app ID/);
  }

  // Renderer disabled (RENDER_APP_BROWSER_PATH unset): degrades with a clear
  // message instead of launching anything.
  {
    const result = await renderAppPreview({ url: "http://localhost:0/x" });
    assert.equal(result.success, false);
    assert.equal(result.status, "error");
    assert.match(result.error ?? "", /RENDER_APP_BROWSER_PATH is unset/);
  }

  // Pool size resolution: default 2, env override, clamped to [1, 16],
  // garbage falls back to the default.
  assert.equal(resolveMaxConcurrentRenders(undefined), 2);
  assert.equal(resolveMaxConcurrentRenders("4"), 4);
  assert.equal(resolveMaxConcurrentRenders("0"), 2);
  assert.equal(resolveMaxConcurrentRenders("-3"), 2);
  assert.equal(resolveMaxConcurrentRenders("999"), 16);
  assert.equal(resolveMaxConcurrentRenders("chromium"), 2);

  // Base URL: trailing slash stripped, CLIENT_URL wins over PUBLIC_URL.
  {
    const prevClient = process.env.CLIENT_URL;
    const prevPublic = process.env.PUBLIC_URL;
    process.env.CLIENT_URL = "https://app.example.com/";
    process.env.PUBLIC_URL = "https://public.example.com";
    assert.equal(clientBaseUrl(), "https://app.example.com");
    delete process.env.CLIENT_URL;
    assert.equal(clientBaseUrl(), "https://public.example.com");
    delete process.env.PUBLIC_URL;
    assert.equal(clientBaseUrl(), "http://localhost:5173");
    if (prevClient !== undefined) process.env.CLIENT_URL = prevClient;
    if (prevPublic !== undefined) process.env.PUBLIC_URL = prevPublic;
  }

  // eslint-disable-next-line no-console
  console.log("app-verify.service tests passed");
  // Imported schema/tool modules hold live handles (mongoose models); an
  // explicit exit keeps the tsx test chain moving.
  // eslint-disable-next-line no-process-exit
  process.exit(0);
}

main().catch(err => {
  console.error(err);
  // eslint-disable-next-line no-process-exit
  process.exit(1);
});

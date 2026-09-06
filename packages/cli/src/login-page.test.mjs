import { test } from "node:test";
import assert from "node:assert/strict";
import { loginPage } from "./login-page.js";

test("OAuth error parameters render as text, never executable HTML", () => {
  const html = loginPage("error", '<script>alert("token")</script>&\'');
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;token&quot;)&lt;/script&gt;&amp;&#39;"));
});

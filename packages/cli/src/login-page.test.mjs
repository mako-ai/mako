import { test } from "node:test";
import assert from "node:assert/strict";
import { loginPage } from "./login-page.js";
import { authorizeUrl } from "./login.js";

test("OAuth error parameters render as text, never executable HTML", () => {
  const html = loginPage("error", '<script>alert("token")</script>&\'');
  assert.ok(!html.includes("<script>"));
  assert.ok(html.includes("&lt;script&gt;alert(&quot;token&quot;)&lt;/script&gt;&amp;&#39;"));
});

// `mako login --warehouse-write` arrived at the consent page with the box
// unticked. The CLI half: the flag must put the scope on the authorize URL
// (the server half, pre-ticking it, is api/src/auth/auth-page.test.ts).
test("--warehouse-write puts warehouse:write on the authorize URL; plain login does not", () => {
  const meta = { authorization_endpoint: "https://mako.test/api/oauth/mcp/authorize" };
  const args = { apiUrl: "https://mako.test/", clientId: "mcpc_1", redirectUri: "http://127.0.0.1:5000/callback", challenge: "c", state: "s" };
  const withFlag = authorizeUrl(meta, { ...args, flags: { "warehouse-write": true } });
  assert.equal(withFlag.searchParams.get("scope"), "mcp query:read warehouse:write");
  assert.equal(withFlag.searchParams.get("resource"), "https://mako.test/api/mcp");
  assert.equal(withFlag.searchParams.get("code_challenge_method"), "S256");
  const plain = authorizeUrl(meta, { ...args, flags: {} });
  assert.equal(plain.searchParams.get("scope"), "mcp query:read");
});

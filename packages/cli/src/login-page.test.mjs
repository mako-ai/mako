import { test } from "node:test";
import assert from "node:assert/strict";
import { loginPage } from "./login-page.js";
import { authorizeUrl } from "./login.js";

test("OAuth error parameters render as text, never executable HTML", () => {
  const html = loginPage("error", '<script>alert("token")</script>&\'');
  assert.ok(!html.includes("<script>"));
  assert.ok(
    html.includes(
      "&lt;script&gt;alert(&quot;token&quot;)&lt;/script&gt;&amp;&#39;",
    ),
  );
});

// A plain `mako login` asks for everything; there is no opt-in flag left
// (`--warehouse-write` is accepted for old scripts and changes nothing).
test("login asks for the full scope set, with or without the old flag", () => {
  const meta = {
    authorization_endpoint: "https://mako.test/api/oauth/mcp/authorize",
  };
  const args = {
    apiUrl: "https://mako.test/",
    clientId: "mcpc_1",
    redirectUri: "http://127.0.0.1:5000/callback",
    challenge: "c",
    state: "s",
  };
  const all = "mcp query:read warehouse:write connections:write";
  const plain = authorizeUrl(meta, { ...args, flags: {} });
  assert.equal(plain.searchParams.get("scope"), all);
  assert.equal(plain.searchParams.get("resource"), "https://mako.test/api/mcp");
  assert.equal(plain.searchParams.get("code_challenge_method"), "S256");
  const withFlag = authorizeUrl(meta, {
    ...args,
    flags: { "warehouse-write": true },
  });
  assert.equal(withFlag.searchParams.get("scope"), all);
});

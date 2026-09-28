/**
 * `mako whoami` on 2026-09-28 printed "Signed in … (token expires
 * 2026-09-17…)" as if that were fine. Pinned: an expired token is called
 * expired, refreshed when it can be, and otherwise sends you to `mako login`
 * with a non-zero exit.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { whoami } from "./whoami.js";

const NOW = Date.parse("2026-09-28T10:00:00Z");
const CTX = { apiUrl: "https://app.mako.ai", workspaceId: "ws1" };

function entry(overrides = {}) {
  return {
    apiUrl: "https://app.mako.ai",
    workspaceId: "ws1",
    clientId: "mcpc_x",
    accessToken: "mcpat_old",
    refreshToken: "mcprt_x",
    expiresAt: "2026-09-17T08:00:00.000Z",
    scopes: ["mcp", "query:read"],
    ...overrides,
  };
}

async function run(stored, deps = {}) {
  const lines = [];
  const saved = [];
  const code = await whoami(CTX, { log: l => lines.push(l) }, {
    now: NOW,
    findCredential: () => stored,
    saveCredential: (...args) => saved.push(args),
    ...deps,
  });
  return { code, output: lines.join("\n"), saved };
}

test("a valid token prints its expiry and scopes", async () => {
  const { code, output } = await run(entry({ expiresAt: "2026-09-28T18:00:00.000Z" }));
  assert.equal(code, 0);
  assert.match(output, /token expires 2026-09-28T18:00:00.000Z/);
  assert.match(output, /Scopes: mcp query:read/);
});

test("an expired token with a refresh token is refreshed and saved", async () => {
  const { code, output, saved } = await run(entry(), {
    refreshCredential: async e => ({ ...e, accessToken: "mcpat_new", expiresAt: "2026-09-28T18:00:00.000Z" }),
  });
  assert.equal(code, 0);
  assert.match(output, /expired 2026-09-17T08:00:00.000Z; refreshed, now expires 2026-09-28T18:00:00.000Z/);
  assert.equal(saved.length, 1);
  assert.equal(saved[0][2].accessToken, "mcpat_new");
});

test("an expired token whose refresh fails says so and suggests mako login", async () => {
  const { code, output, saved } = await run(entry(), {
    refreshCredential: async () => {
      throw new Error("token refresh failed: HTTP 400 invalid_grant — run `mako login` again");
    },
  });
  assert.equal(code, 1);
  assert.match(output, /expired 2026-09-17T08:00:00.000Z and could not be refreshed \(token refresh failed: HTTP 400 invalid_grant\)/);
  assert.match(output, /Run `mako login`/);
  assert.equal(saved.length, 0);
});

test("an expired token without a refresh token says so, exit 1", async () => {
  const { code, output } = await run(entry({ refreshToken: undefined }));
  assert.equal(code, 1);
  assert.match(output, /but the token expired 2026-09-17T08:00:00.000Z. Run `mako login`/);
});

test("nobody signed in", async () => {
  const { code, output } = await run(null);
  assert.equal(code, 1);
  assert.match(output, /Not signed in/);
});

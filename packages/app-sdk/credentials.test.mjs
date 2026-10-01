import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import {
  credentialKey, findCredential, getAccessToken, readCredentialStore, removeCredential, saveCredential,
} from "./credentials.js";

const file = () => path.join(fs.mkdtempSync(path.join(os.tmpdir(), "mako-cred-")), "credentials.json");

test("save/find: exact workspace first, host wildcard as fallback", () => {
  const f = file();
  saveCredential("https://api.test/", null, { clientId: "c", accessToken: "any" }, f);
  saveCredential("https://api.test", "ws1", { clientId: "c", accessToken: "ws1" }, f);
  const store = readCredentialStore(f);
  assert.deepEqual(Object.keys(store).sort(), ["https://api.test#*", "https://api.test#ws1"]);
  assert.equal(findCredential("https://api.test", "ws1", store).accessToken, "ws1");
  assert.equal(findCredential("https://api.test", "ws2", store).accessToken, "any");
  assert.equal(findCredential("https://other.test", "ws1", store), null);
  assert.equal(credentialKey("https://api.test///", undefined), "https://api.test#*");
  assert.equal((fs.statSync(f).mode & 0o777), 0o600);
  assert.equal(removeCredential("https://api.test", "ws1", f), true);
  assert.equal(findCredential("https://api.test", "ws1", readCredentialStore(f)).accessToken, "any");
});

test("getAccessToken refreshes an expiring token and persists the rotation", async () => {
  const f = file();
  saveCredential("https://api.test", "ws1", {
    clientId: "cid", accessToken: "old", refreshToken: "r1",
    expiresAt: new Date(Date.now() + 10_000).toISOString(),
  }, f);
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, body: Object.fromEntries(new URLSearchParams(init.body)) });
    return new Response(JSON.stringify({ access_token: "new", refresh_token: "r2", expires_in: 3600, scope: "mcp query:read" }), { status: 200 });
  };
  assert.equal(await getAccessToken("https://api.test", "ws1", { file: f, fetch: fetchImpl }), "new");
  assert.equal(calls[0].url, "https://api.test/api/oauth/mcp/token");
  assert.deepEqual(calls[0].body, { grant_type: "refresh_token", refresh_token: "r1", client_id: "cid" });
  const stored = findCredential("https://api.test", "ws1", readCredentialStore(f));
  assert.equal(stored.refreshToken, "r2");
  assert.deepEqual(stored.scopes, ["mcp", "query:read"]);
  // Fresh now: no second call.
  assert.equal(await getAccessToken("https://api.test", "ws1", { file: f, fetch: fetchImpl }), "new");
  assert.equal(calls.length, 1);
  assert.equal(await getAccessToken("https://nobody.test", null, { file: f }), null);
});

test("a CLI credential unused for years renews without another browser login", async () => {
  const f = file();
  saveCredential("https://api.test", null, {
    clientId: "cid", accessToken: "old", refreshToken: "persistent-grant",
    expiresAt: "2000-01-01T00:00:00.000Z",
  }, f);
  const fetchImpl = async (_url, init) => {
    assert.equal(new URLSearchParams(init.body).get("refresh_token"), "persistent-grant");
    return new Response(JSON.stringify({
      access_token: "renewed", refresh_token: "rotated-grant", expires_in: 28800,
    }));
  };
  assert.equal(await getAccessToken("https://api.test", "ws1", { file: f, fetch: fetchImpl }), "renewed");
  assert.equal(findCredential("https://api.test", "ws1", readCredentialStore(f)).refreshToken, "rotated-grant");
  fs.rmSync(path.dirname(f), { recursive: true });
});

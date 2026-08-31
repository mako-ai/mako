import { test } from "node:test";
import assert from "node:assert/strict";
import { parseArgs } from "./args.js";
import { pkcePair } from "./login.js";
import crypto from "node:crypto";

test("parseArgs", () => {
  assert.deepEqual(parseArgs(["dev", "latest-sales", "--port", "4173", "--open"]), {
    command: "dev", positional: ["latest-sales"], flags: { port: "4173", open: true },
  });
  assert.deepEqual(parseArgs(["login", "--api-url=http://localhost:8080", "--no-browser"]).flags, {
    "api-url": "http://localhost:8080", browser: false,
  });
  assert.equal(parseArgs([]).command, null);
});

test("pkce challenge is S256 of the verifier", () => {
  const { verifier, challenge } = pkcePair();
  assert.equal(crypto.createHash("sha256").update(verifier).digest("base64url"), challenge);
  assert.ok(verifier.length >= 43);
});

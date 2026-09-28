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

test("parseArgs: short flags, as `mako dbt run -s <selector>` needs", () => {
  assert.deepEqual(parseArgs(["dbt", "run", "-s", "stg_orders+", "--full-refresh"]), {
    command: "dbt", positional: ["run"], flags: { s: "stg_orders+", "full-refresh": true },
  });
  // A selector never starts with "-", so a following flag is not its value.
  assert.deepEqual(parseArgs(["dbt", "run", "-s", "--env", "dev"]).flags, { s: true, env: "dev" });
});

test("pkce challenge is S256 of the verifier", () => {
  const { verifier, challenge } = pkcePair();
  assert.equal(crypto.createHash("sha256").update(verifier).digest("base64url"), challenge);
  assert.ok(verifier.length >= 43);
});

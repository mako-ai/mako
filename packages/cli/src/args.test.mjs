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

test("parseArgs: boolean flags never swallow the next token (review #1013)", () => {
  assert.deepEqual(parseArgs(["dbt", "run", "--full-refresh", "-s", "stg_orders"]), {
    command: "dbt", positional: ["run"], flags: { "full-refresh": true, s: "stg_orders" },
  });
  // Not even a positional-looking one: `--open` is boolean, `app` is an argument.
  assert.deepEqual(parseArgs(["dev", "--open", "sales"]), {
    command: "dev", positional: ["sales"], flags: { open: true },
  });
  assert.deepEqual(parseArgs(["login", "--warehouse-write", "--api-url", "http://x"]).flags, {
    "warehouse-write": true, "api-url": "http://x",
  });
  // A value flag followed by a single-dash flag gets no value either.
  assert.deepEqual(parseArgs(["dbt", "run", "--env", "-s", "m"]).flags, { env: true, s: "m" });
  assert.deepEqual(parseArgs(["dbt", "run", "--no-defer", "-s", "m"]).flags, { defer: false, s: "m" });
});

test("pkce challenge is S256 of the verifier", () => {
  const { verifier, challenge } = pkcePair();
  assert.equal(crypto.createHash("sha256").update(verifier).digest("base64url"), challenge);
  assert.ok(verifier.length >= 43);
});

import assert from "node:assert/strict";
import {
  clipStatusDescription,
  isStatusPermissionError,
  logStatusPostFailure,
  makoClientUrl,
} from "./commit-status";

// One line, GitHub's 140-character cap, an ellipsis where it was cut.
assert.equal(clipStatusDescription("  a\n  b\tc  "), "a b c");
const long = clipStatusDescription("x".repeat(200));
assert.equal(long.length, 140);
assert.ok(long.endsWith("…"));
assert.equal(clipStatusDescription("abcdef", 4), "abc…");

assert.equal(isStatusPermissionError("GitHub 403: Forbidden"), true);
assert.equal(isStatusPermissionError("GitHub 404 Not Found"), true);
assert.equal(
  isStatusPermissionError("Resource not accessible by integration"),
  true,
);
assert.equal(isStatusPermissionError("GitHub 500"), false);
assert.equal(isStatusPermissionError("GitHub 4031"), false);

const saved = { client: process.env.CLIENT_URL, pub: process.env.PUBLIC_URL };
process.env.CLIENT_URL = "https://mako.example/";
assert.equal(makoClientUrl("/apps/x"), "https://mako.example/apps/x");
delete process.env.CLIENT_URL;
process.env.PUBLIC_URL = "https://public.example";
assert.equal(makoClientUrl("/settings"), "https://public.example/settings");
delete process.env.PUBLIC_URL;
assert.equal(makoClientUrl("/settings"), undefined);
if (saved.client !== undefined) process.env.CLIENT_URL = saved.client;
if (saved.pub !== undefined) process.env.PUBLIC_URL = saved.pub;

// A permission problem is logged once per workspace; anything else always.
const lines: Array<Record<string, unknown>> = [];
const logger = {
  warn: (_what: string, meta: Record<string, unknown>) => lines.push(meta),
} as unknown as Parameters<typeof logStatusPostFailure>[0];
const warned = new Set<string>();
const forbidden = new Error("GitHub 403: Resource not accessible");
assert.equal(
  logStatusPostFailure(logger, "x", forbidden, warned, { workspaceId: "w1" }),
  "permission",
);
assert.equal(
  logStatusPostFailure(logger, "x", forbidden, warned, { workspaceId: "w1" }),
  "permission",
);
assert.equal(lines.length, 1);
assert.ok(typeof lines[0].hint === "string");
assert.equal(
  logStatusPostFailure(logger, "x", "boom", warned, { workspaceId: "w1" }),
  "error",
);
assert.equal(
  logStatusPostFailure(logger, "x", "boom", warned, { workspaceId: "w1" }),
  "error",
);
assert.equal(lines.length, 3);
assert.equal(lines[2].error, "boom");
assert.equal("hint" in lines[2], false);

console.log("commit-status tests passed");

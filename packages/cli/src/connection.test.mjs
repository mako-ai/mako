/**
 * `mako connection probe` speaks MCP; a stubbed fetch stands in for the
 * server. What is pinned: a NAME resolves to an id through list_connections
 * (kind: source), the flags reach the server in the tool's shape, a failed
 * check exits non-zero, and bad flags never reach the server at all.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { connection } from "./connection.js";

/** Answer MCP tools/call requests from a table of tool name -> payload. */
function stubMcp(answers) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const rpc = JSON.parse(init.body);
    calls.push({
      url: String(url),
      name: rpc.params.name,
      args: rpc.params.arguments,
    });
    const payload =
      typeof answers[rpc.params.name] === "function"
        ? answers[rpc.params.name](rpc.params.arguments)
        : answers[rpc.params.name];
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: { content: [{ type: "text", text: JSON.stringify(payload) }] },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const CTX = {
  apiUrl: "https://mako.test",
  apiKey: "revops_test",
  workspaceId: "ws1",
};
const VERCEL_ID = "6a980ccb30c0807dd4d98396";

async function runProbe(target, flags = {}) {
  const lines = [];
  const code = await connection(CTX, ["probe", target], flags, {
    log: line => lines.push(line),
  });
  return { code, output: lines.join("\n") };
}

test("probe resolves a connection by NAME, then reads one page and shows it", async () => {
  const mcp = stubMcp({
    list_connections: [
      {
        id: VERCEL_ID,
        name: "Vercel AI Gateway Usage",
        kind: "source",
        connector: "ws:vercel-ai-gateway",
      },
      {
        id: "68513719eeee2756233f5c2a",
        name: "ch_close",
        kind: "source",
        connector: "close",
      },
    ],
    probe_connection: {
      connection: {
        id: VERCEL_ID,
        name: "Vercel AI Gateway Usage",
        connector: "ws:vercel-ai-gateway",
      },
      check: { success: true, message: "Connection successful" },
      entity: {
        name: "daily-usage",
        schema: { day: "string", total_cost: "number" },
        records: [
          { day: "2026-09-01", total_cost: 1.25, request_count: 40 },
          { day: "2026-09-02", total_cost: 0.5, request_count: 12 },
        ],
        count: 2,
        received: 2,
        truncated: false,
        hasMore: false,
        logs: [],
      },
      durationMs: 1234,
    },
  });
  try {
    const { code, output } = await runProbe("vercel ai gateway usage", {
      entity: "daily-usage",
      limit: "5",
      fields: "day,total_cost",
    });
    assert.equal(code, 0, output);
    assert.deepEqual(
      mcp.calls.map(c => c.name),
      ["list_connections", "probe_connection"],
    );
    assert.deepEqual(mcp.calls[0].args, { kind: "source" });
    assert.deepEqual(mcp.calls[1].args, {
      connectionId: VERCEL_ID,
      entity: "daily-usage",
      limit: 5,
      fields: ["day", "total_cost"],
    });
    assert.ok(mcp.calls.every(c => c.url === "https://mako.test/api/mcp"));
    assert.match(output, /check: connected/);
    assert.match(output, /daily-usage: 2 record\(s\)/);
    assert.match(output, /2026-09-01\s+1\.25/);
    assert.match(output, /nothing was written/);
  } finally {
    mcp.restore();
  }
});

test("probe passes an id straight through, and a failed check exits 1", async () => {
  const mcp = stubMcp({
    probe_connection: {
      connection: {
        id: VERCEL_ID,
        name: "Vercel AI Gateway Usage",
        connector: "ws:vercel-ai-gateway",
      },
      check: { success: false, message: "401 Unauthorized" },
      durationMs: 800,
    },
  });
  try {
    const { code, output } = await runProbe(VERCEL_ID);
    assert.equal(code, 1);
    assert.deepEqual(
      mcp.calls.map(c => c.name),
      ["probe_connection"],
    );
    assert.match(output, /FAIL\s+check: 401 Unauthorized/);
  } finally {
    mcp.restore();
  }
});

test("probe of an unknown name lists the source connections that ARE configured", async () => {
  const mcp = stubMcp({
    list_connections: [
      { id: VERCEL_ID, name: "Vercel", kind: "source", connector: "ws:vercel" },
    ],
  });
  try {
    const { code, output } = await runProbe("stripe-prod");
    assert.equal(code, 1);
    assert.match(output, /no source connection named "stripe-prod"/);
    assert.match(output, new RegExp(`${VERCEL_ID}\\s+Vercel`));
    assert.deepEqual(
      mcp.calls.map(c => c.name),
      ["list_connections"],
    );
  } finally {
    mcp.restore();
  }
});

test("probe --json prints the server's result verbatim; a server error exits 1", async () => {
  const mcp = stubMcp({
    probe_connection: { error: "no such entity", code: "unknown_entity" },
  });
  try {
    const { code, output } = await runProbe(VERCEL_ID, {
      entity: "nope",
      json: true,
    });
    assert.equal(code, 1);
    assert.deepEqual(JSON.parse(output), {
      error: "no such entity",
      code: "unknown_entity",
    });
  } finally {
    mcp.restore();
  }
});

test("probe refuses a bad --limit or --since before talking to the server", async () => {
  const mcp = stubMcp({});
  try {
    assert.equal((await runProbe(VERCEL_ID, { limit: "lots" })).code, 2);
    assert.equal((await runProbe(VERCEL_ID, { since: "yesterday" })).code, 2);
    assert.deepEqual(mcp.calls, []);
  } finally {
    mcp.restore();
  }
});

test("`mako connection` without probe prints help; `mako connector probe` is gone", async () => {
  const lines = [];
  assert.equal(await connection(CTX, [], {}, { log: l => lines.push(l) }), 0);
  assert.match(lines.join("\n"), /mako connection probe <id\|name>/);
});

/**
 * `mako sync` speaks MCP; a stubbed fetch stands in for the server. Pinned:
 * each subcommand calls its tool with the tool's arguments, a refusal exits
 * non-zero, and bad flags never reach the server.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { sync } from "./sync.js";

function stubMcp(answers) {
  const calls = [];
  const original = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    const rpc = JSON.parse(init.body);
    calls.push({ name: rpc.params.name, args: rpc.params.arguments });
    return new Response(
      JSON.stringify({
        jsonrpc: "2.0",
        id: rpc.id,
        result: {
          content: [
            { type: "text", text: JSON.stringify(answers[rpc.params.name]) },
          ],
        },
      }),
      { status: 200, headers: { "content-type": "application/json" } },
    );
  };
  return { calls, restore: () => (globalThis.fetch = original) };
}

const CTX = {
  apiUrl: "https://mako.test",
  apiKey: "revops_test",
  workspaceId: "w",
};
const io = () => {
  const lines = [];
  return { lines, log: line => lines.push(line) };
};

test("ls lists every sync with its triggers", async () => {
  const mcp = stubMcp({
    flow_list: {
      success: true,
      flows: [
        {
          id: "64bd0d58db465c90dfc61964",
          name: "fr_stripe → bigquery_write",
          source: { kind: "connector", connector: "stripe" },
          triggers: {
            poll: { cron: "0 4 * * *" },
            webhook: true,
            resync: { cron: "0 3 * * 0" },
          },
          engine: "cdc",
          state: "active",
        },
      ],
    },
  });
  try {
    const out = io();
    assert.equal(await sync(CTX, ["ls"], {}, out), 0);
    assert.deepEqual(mcp.calls, [{ name: "flow_list", args: {} }]);
    const text = out.lines.join("\n");
    assert.match(text, /fr_stripe → bigquery_write/);
    assert.match(text, /poll 0 4 \* \* \* \+ webhook \+ resync 0 3 \* \* 0/);
  } finally {
    mcp.restore();
  }
});

test("set sends only the controls given, and a refusal exits 1", async () => {
  const mcp = stubMcp({
    flow_update: { success: false, error: "Owner/admin role required" },
  });
  try {
    const out = io();
    const code = await sync(
      CTX,
      ["set", "wise → bigquery_write"],
      { poll: "0 * * * *", resync: "off" },
      out,
    );
    assert.equal(code, 1);
    assert.deepEqual(mcp.calls, [
      {
        name: "flow_update",
        args: {
          flow: "wise → bigquery_write",
          poll: "0 * * * *",
          resync: "off",
        },
      },
    ]);
    assert.match(out.lines.join("\n"), /Owner\/admin role required/);
  } finally {
    mcp.restore();
  }
});

test("bad flags never reach the server", async () => {
  const mcp = stubMcp({});
  try {
    assert.equal(
      await sync(CTX, ["set", "wise"], { webhook: "maybe" }, io()),
      2,
    );
    assert.equal(await sync(CTX, ["set", "wise"], {}, io()), 2);
    assert.equal(await sync(CTX, ["status"], {}, io()), 2);
    assert.deepEqual(mcp.calls, []);
  } finally {
    mcp.restore();
  }
});

test("backfill passes entities and names the run", async () => {
  const mcp = stubMcp({
    flow_backfill: { success: true, runId: "run_1", resumed: false },
  });
  try {
    const out = io();
    assert.equal(
      await sync(
        CTX,
        ["backfill", "wise"],
        { entity: "transfers, balances" },
        out,
      ),
      0,
    );
    assert.deepEqual(mcp.calls, [
      {
        name: "flow_backfill",
        args: { flow: "wise", entities: ["transfers", "balances"] },
      },
    ]);
    assert.match(out.lines.join("\n"), /run run_1/);
  } finally {
    mcp.restore();
  }
});

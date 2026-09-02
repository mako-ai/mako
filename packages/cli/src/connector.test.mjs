/**
 * The conformance command must FAIL on the things that silently break a sync.
 * A test that only proves a good connector passes would not have caught any of
 * the three problems below, each of which is invisible until production.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { connector } from "./connector.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const SDK = path.resolve(here, "../../connector-sdk/index.js");
const GOOD = path.resolve(here, "../../connector-sdk/fixtures/connector.ts");

function scratch(files) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mako-cli-connector-"));
  for (const [name, contents] of Object.entries(files)) {
    fs.writeFileSync(path.join(dir, name), contents);
  }
  return dir;
}

async function runTest(target, flags = {}) {
  const lines = [];
  const code = await connector({}, ["test", target], flags, {
    log: line => lines.push(line),
  });
  return { code, output: lines.join("\n") };
}

test("a good connector passes offline, and fully with a credential", async () => {
  const offline = await runTest(GOOD);
  assert.equal(offline.code, 0);
  assert.match(offline.output, /Offline checks passed/);

  const dir = scratch({
    "config.json": JSON.stringify({ apiKey: "good-key" }),
  });
  const full = await runTest(GOOD, { config: path.join(dir, "config.json") });
  assert.equal(full.code, 0, full.output);
  assert.match(full.output, /check: connected/);
  assert.match(full.output, /resumes cleanly/);
});

test("an unmarked secret fails, because it would be stored in plaintext", async () => {
  const dir = scratch({
    "connector.yaml": "runtime: node\n",
    "connector.ts": `
      import { defineConnector } from ${JSON.stringify(SDK)};
      export default defineConnector({
        name: "leaky", version: "1.0.0",
        config: { required: ["api_token"], properties: { api_token: { type: "string" } } },
        entities: { rows: { schema: { id: "string" }, async *read() { yield { records: [], hasMore: false }; } } },
      });
    `,
  });
  const { code, output } = await runTest(dir);
  assert.equal(code, 1);
  assert.match(output, /api_token.*not marked/s);
  assert.match(output, /unencrypted/);
});

test("a state that does not advance fails, because the sync would loop forever", async () => {
  const dir = scratch({
    "connector.yaml": "runtime: node\n",
    "config.json": JSON.stringify({ apiKey: "x" }),
    "connector.ts": `
      import { defineConnector } from ${JSON.stringify(SDK)};
      export default defineConnector({
        name: "looper", version: "1.0.0",
        config: { properties: {} },
        entities: {
          rows: {
            schema: { id: "string" },
            async *read() { while (true) yield { records: [{ id: "same" }], state: { page: 1 }, hasMore: true }; },
          },
        },
      });
    `,
  });
  const { code, output } = await runTest(dir, {
    config: path.join(dir, "config.json"),
  });
  assert.equal(code, 1);
  assert.match(output, /state does not advance/);
});

test("a declared type the records contradict fails", async () => {
  const dir = scratch({
    "connector.yaml": "runtime: node\n",
    "config.json": JSON.stringify({}),
    "connector.ts": `
      import { defineConnector } from ${JSON.stringify(SDK)};
      export default defineConnector({
        name: "liar", version: "1.0.0",
        config: { properties: {} },
        entities: {
          rows: {
            schema: { id: "string", count: "string" },
            async *read() { yield { records: [{ id: "a", count: 7 }], hasMore: false }; },
          },
        },
      });
    `,
  });
  const { code, output } = await runTest(dir, {
    config: path.join(dir, "config.json"),
  });
  assert.equal(code, 1);
  assert.match(output, /count declared string but emitted integer/);
});

test("a folder without connector.yaml is refused, since Mako would never find it", async () => {
  const dir = scratch({ "connector.ts": "export default {};\n" });
  const { code, output } = await runTest(dir);
  assert.equal(code, 1);
  assert.match(output, /no connector\.yaml/);
});

test("a folder whose connector.yaml names another entry is tested at that entry", async () => {
  // The server runs the file `entry:` names. A gate that only ever looked at
  // connector.ts would refuse a layout production indexes happily.
  const dir = scratch({
    "connector.yaml": "runtime: node\nentry: src/index.ts\n",
  });
  fs.mkdirSync(path.join(dir, "src"));
  fs.writeFileSync(
    path.join(dir, "src/index.ts"),
    fs.readFileSync(GOOD, "utf8").replace('"../index.js"', JSON.stringify(SDK)),
  );

  const { code, output } = await runTest(dir);
  assert.equal(code, 0, output);
  assert.match(output, /spec: fixture/);
});

test("a spec without declared config properties fails, as the push would", async () => {
  const dir = scratch({
    "connector.yaml": "runtime: node\n",
    "connector.ts": `
      import { defineConnector } from ${JSON.stringify(SDK)};
      const base = defineConnector({
        name: "silent", version: "1.0.0",
        entities: { rows: { schema: { id: "string" }, async *read() { yield { records: [], hasMore: false }; } } },
      });
      // A spec that forgot to describe its config at all: the shape that made
      // Mako store credentials unencrypted.
      export default { ...base, spec: () => ({ connectionSpecification: { type: "object" } }) };
    `,
  });

  const { code, output } = await runTest(dir);
  assert.equal(code, 1);
  assert.match(output, /config: \{ properties \}/);
});

// ---------------------------------------------------------------------------
// probe — speaks MCP; a stubbed fetch stands in for the server.
// ---------------------------------------------------------------------------

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
  const code = await connector(CTX, ["probe", target], flags, {
    log: line => lines.push(line),
  });
  return { code, output: lines.join("\n") };
}

test("probe resolves a connector by NAME, then reads one page and shows it", async () => {
  const mcp = stubMcp({
    list_connectors: {
      connectors: [
        {
          id: VERCEL_ID,
          name: "Vercel AI Gateway Usage",
          type: "ws:vercel-ai-gateway",
        },
        { id: "68513719eeee2756233f5c2a", name: "ch_close", type: "close" },
      ],
    },
    probe_connector: {
      connector: {
        id: VERCEL_ID,
        name: "Vercel AI Gateway Usage",
        type: "ws:vercel-ai-gateway",
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
      ["list_connectors", "probe_connector"],
    );
    assert.deepEqual(mcp.calls[1].args, {
      connectorId: VERCEL_ID,
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
    probe_connector: {
      connector: {
        id: VERCEL_ID,
        name: "Vercel AI Gateway Usage",
        type: "ws:vercel-ai-gateway",
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
      ["probe_connector"],
    );
    assert.match(output, /FAIL\s+check: 401 Unauthorized/);
  } finally {
    mcp.restore();
  }
});

test("probe of an unknown name lists what IS configured", async () => {
  const mcp = stubMcp({
    list_connectors: {
      connectors: [{ id: VERCEL_ID, name: "Vercel", type: "ws:vercel" }],
    },
  });
  try {
    const { code, output } = await runProbe("stripe-prod");
    assert.equal(code, 1);
    assert.match(output, /no connector named "stripe-prod"/);
    assert.match(output, new RegExp(`${VERCEL_ID}\\s+Vercel`));
    assert.deepEqual(
      mcp.calls.map(c => c.name),
      ["list_connectors"],
    );
  } finally {
    mcp.restore();
  }
});

test("probe --json prints the server's result verbatim; a server error exits 1", async () => {
  const mcp = stubMcp({
    probe_connector: { error: "no such entity", code: "unknown_entity" },
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

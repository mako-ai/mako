/**
 * What the PandaDoc and Claap folders need from the SDK:
 * - a read may end its chunk early with `hasMore: true` (a per-chunk cap of
 *   its own, a quota checkpoint), and the next chunk resumes from its state;
 * - the `shared-secret` scheme, a signature sent as a query parameter, and
 *   where a delivery's event id and type sit, as data in the spec;
 * - the flow's entities handed to `handleBatch`.
 */
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { defineConnector } from "./define.js";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "bin", "mako-connector.js");
const SDK = pathToFileURL(path.join(here, "..", "index.js")).href;

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mako-chunk-end-"));
const writeJson = (dir, name, value) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};

/** A connector whose read yields 3 pages a chunk, then returns, over 7 pages. */
function writeConnector(dir, { moveState = true } = {}) {
  const file = path.join(dir, "connector.mjs");
  fs.writeFileSync(
    file,
    `import { defineConnector } from ${JSON.stringify(SDK)};
export default defineConnector({
  name: "capped",
  version: "1.0.0",
  config: { properties: {} },
  entities: {
    rows: {
      primaryKey: ["id"],
      schema: { id: "string" },
      async *read(ctx, state) {
        let page = typeof state.page === "number" ? state.page : 1;
        for (let n = 0; n < 3; n++) {
          const last = page === 7;
          yield {
            records: [{ id: "r" + page }],
            state: ${moveState ? "{ page: page + 1 }" : "{}"},
            hasMore: !last,
          };
          if (last) return;
          page++;
        }
      },
    },
    other: { schema: { id: "string" }, async *read() { yield { records: [], hasMore: false }; } },
  },
  webhooks: {
    verification: { scheme: "shared-secret", secretHeader: "x-vendor-secret" },
    eventIdPath: "eventId",
    eventTypePath: "event.type",
    handleBatch: (ctx, events, options) =>
      events.map(e => ({
        eventId: e.eventId,
        outcome: "skipped",
        reason: JSON.stringify(options),
      })),
  },
});
`,
  );
  return file;
}

async function protocol(connector, args) {
  try {
    const { stdout } = await run(process.execPath, [BIN, ...args, "--connector", connector]);
    return { messages: parse(stdout), failed: false };
  } catch (error) {
    return { messages: parse(error.stdout ?? ""), failed: true };
  }
}
const parse = stdout =>
  stdout
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));

test("a read that returns after hasMore: true ends its chunk, and the next resumes there", async () => {
  const dir = tmp();
  const connector = writeConnector(dir);
  const catalog = writeJson(dir, "catalog.json", { streams: [{ stream: { name: "rows" } }] });
  const ids = [];
  const chunks = [];
  let state;
  for (let i = 0; i < 5; i++) {
    const args = ["read", "--catalog", catalog, "--max-iterations", "10"];
    if (state) args.push("--state", writeJson(dir, `state${i}.json`, [state]));
    const { messages, failed } = await protocol(connector, args);
    assert.equal(failed, false);
    ids.push(...messages.filter(m => m.type === "RECORD").map(m => m.record.data.id));
    state = messages.filter(m => m.type === "STATE").at(-1).state;
    chunks.push(state.mako.hasMore);
    if (!state.mako.hasMore) break;
  }
  assert.deepEqual(ids, ["r1", "r2", "r3", "r4", "r5", "r6", "r7"]);
  assert.deepEqual(chunks, [true, true, false]);
});

test("a session ends a batch where the read returned, as a chunk process does", async () => {
  const dir = tmp();
  const connector = writeConnector(dir);
  const catalog = writeJson(dir, "catalog.json", { streams: [{ stream: { name: "rows" } }] });
  const { messages } = await protocol(connector, [
    "read",
    "--catalog",
    catalog,
    "--max-iterations",
    "10",
    "--session",
  ]);
  const states = messages.filter(m => m.type === "STATE").map(m => m.state.mako.hasMore);
  assert.deepEqual(states, [true, true, false]);
  assert.equal(messages.filter(m => m.type === "RECORD").length, 7);
});

test("an early end whose state did not move fails instead of looping", async () => {
  const dir = tmp();
  const connector = writeConnector(dir, { moveState: false });
  const catalog = writeJson(dir, "catalog.json", { streams: [{ stream: { name: "rows" } }] });
  const { messages, failed } = await protocol(connector, ["read", "--catalog", catalog]);
  assert.equal(failed, true);
  const trace = messages.find(m => m.type === "TRACE");
  assert.match(trace.trace.error.message, /hasMore: true and its state unchanged/);
});

test("spec carries the shared-secret scheme and where the event id and type sit", async () => {
  const dir = tmp();
  const { messages } = await protocol(writeConnector(dir), ["spec"]);
  assert.deepEqual(messages[0].spec.mako.webhooks, {
    verification: { scheme: "shared-secret", secretHeader: "x-vendor-secret" },
    eventIdPath: "eventId",
    eventTypePath: "event.type",
  });
});

test("handleBatch gets the flow's entities when the batch carries them", async () => {
  const dir = tmp();
  const connector = writeConnector(dir);
  const event = { eventId: "e1", eventType: "x", rawPayload: {} };
  const withList = writeJson(dir, "a.json", { events: [event], enabledEntities: ["rows"] });
  const without = writeJson(dir, "b.json", { events: [event] });
  const a = await protocol(connector, ["webhook", "--batch", withList]);
  const b = await protocol(connector, ["webhook", "--batch", without]);
  assert.equal(a.messages[0].webhook.reason, JSON.stringify({ enabledEntities: ["rows"] }));
  assert.equal(b.messages[0].webhook.reason, "{}");
});

test("the declarations are checked: secret header, query name, body paths", () => {
  const base = {
    name: "acme",
    version: "1.0.0",
    entities: { rows: { async *read() {} } },
  };
  const hook = webhooks => () => defineConnector({ ...base, webhooks: { handleBatch: () => [], ...webhooks } });
  assert.throws(
    hook({ verification: { scheme: "shared-secret", secretHeader: "X-Upper" } }),
    /secretHeader must be a lowercase header name/,
  );
  const hmac = {
    scheme: "hmac-sha256",
    secretEncoding: "utf8",
    signedPayload: ["body"],
    signatureHeader: "signature",
    signatureEncoding: "hex",
  };
  assert.throws(hook({ verification: { ...hmac, signatureQuery: "a b" } }), /signatureQuery/);
  assert.throws(hook({ verification: hmac, eventIdPath: "a..b" }), /eventIdPath must be a dotted path/);
  assert.throws(hook({ verification: hmac, eventTypePath: "$.x" }), /eventTypePath must be a dotted path/);
  const ok = defineConnector({
    ...base,
    webhooks: { handleBatch: () => [], verification: { ...hmac, signatureQuery: "signature" }, eventTypePath: "0.event" },
  });
  assert.deepEqual(ok.spec().mako.webhooks, {
    verification: { ...hmac, signatureQuery: "signature" },
    eventTypePath: "0.event",
  });
});

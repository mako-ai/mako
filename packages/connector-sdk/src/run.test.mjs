import { test } from "node:test";
import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { parseArgs } from "./run.js";

const run = promisify(execFile);
const here = path.dirname(fileURLToPath(import.meta.url));
const BIN = path.join(here, "..", "bin", "mako-connector.js");
const FIXTURE = path.join(here, "..", "fixtures", "connector.ts");

const tmp = () => fs.mkdtempSync(path.join(os.tmpdir(), "mako-connector-"));

const writeJson = (dir, name, value) => {
  const file = path.join(dir, name);
  fs.writeFileSync(file, JSON.stringify(value));
  return file;
};

/** Run a command and parse the protocol stream it wrote. */
async function protocol(args, { expectFailure = false } = {}) {
  let stdout = "";
  try {
    ({ stdout } = await run(process.execPath, [BIN, ...args, "--connector", FIXTURE]));
    assert.equal(expectFailure, false, "expected a non-zero exit");
  } catch (error) {
    assert.equal(expectFailure, true, `unexpected failure: ${error.stderr || error.message}`);
    stdout = error.stdout ?? "";
  }
  return stdout
    .split("\n")
    .filter(Boolean)
    .map(line => JSON.parse(line));
}

test("spec exposes the config JSON Schema the credential form is built from", async () => {
  const [message] = await protocol(["spec"]);
  assert.equal(message.type, "SPEC");
  const config = message.spec.connectionSpecification;
  assert.deepEqual(config.required, ["apiKey"]);
  assert.equal(config.properties.apiKey.airbyte_secret, true);
  assert.equal(message.spec.mako.name, "fixture");
});

test("check succeeds with a good credential", async () => {
  const dir = tmp();
  const config = writeJson(dir, "config.json", { apiKey: "good-key" });
  const [message] = await protocol(["check", "--config", config]);
  assert.equal(message.connectionStatus.status, "SUCCEEDED");
});

test("a bad credential is a FAILED status carrying the vendor's message, not a crash", async () => {
  const dir = tmp();
  const config = writeJson(dir, "config.json", { apiKey: "revoked" });
  const [message] = await protocol(["check", "--config", config]);
  assert.equal(message.connectionStatus.status, "FAILED");
  assert.match(message.connectionStatus.message, /revoked/);
});

test("discover reports primary key, cursor and sync modes", async () => {
  const dir = tmp();
  const config = writeJson(dir, "config.json", { apiKey: "good-key" });
  const [message] = await protocol(["discover", "--config", config]);
  const [stream] = message.catalog.streams;
  assert.equal(stream.name, "people");
  assert.deepEqual(stream.source_defined_primary_key, [["id"]]);
  assert.deepEqual(stream.default_cursor_field, ["updated_at"]);
  assert.ok(stream.supported_sync_modes.includes("incremental"));
  assert.deepEqual(stream.json_schema.properties.updated_at, {
    type: ["null", "string"],
    format: "date-time",
  });
});

test("an unbounded read emits every record and ends with hasMore false", async () => {
  const dir = tmp();
  const config = writeJson(dir, "config.json", { apiKey: "good-key" });
  const messages = await protocol(["read", "--config", config]);
  const records = messages.filter(m => m.type === "RECORD");
  assert.equal(records.length, 25);
  assert.equal(records[0].record.stream, "people");
  const state = messages.at(-1);
  assert.equal(state.type, "STATE");
  assert.equal(state.state.mako.hasMore, false);
});

test("a stream ending exactly at the chunk limit reports exhaustion", async () => {
  const dir = tmp();
  const config = writeJson(dir, "config.json", { apiKey: "good-key" });
  const messages = await protocol([
    "read",
    "--config",
    config,
    "--max-iterations",
    "3",
  ]);
  assert.equal(messages.filter(m => m.type === "RECORD").length, 25);
  assert.equal(messages.at(-1).state.mako.hasMore, false);
});

test("a chunk stops at the budget and its state resumes exactly where it stopped", async () => {
  const dir = tmp();
  const config = writeJson(dir, "config.json", { apiKey: "good-key" });

  const first = await protocol(["read", "--config", config, "--max-iterations", "1"]);
  const firstRecords = first.filter(m => m.type === "RECORD");
  assert.equal(firstRecords.length, 10);
  const firstState = first.at(-1).state;
  assert.equal(firstState.mako.hasMore, true);
  assert.deepEqual(firstState.stream.stream_state, { offset: 10 });

  // Resume: the second chunk must start at record 11, not at record 1.
  const state = writeJson(dir, "state.json", firstState);
  const second = await protocol([
    "read",
    "--config",
    config,
    "--state",
    state,
    "--max-iterations",
    "1",
  ]);
  const secondRecords = second.filter(m => m.type === "RECORD");
  assert.equal(secondRecords.length, 10);
  assert.equal(secondRecords[0].record.data.id, "p11");
  assert.equal(second.at(-1).state.mako.hasMore, true);

  // And the last chunk reports exhaustion rather than an empty extra chunk.
  const third = await protocol([
    "read",
    "--config",
    config,
    "--state",
    writeJson(dir, "state2.json", second.at(-1).state),
    "--max-iterations",
    "5",
  ]);
  assert.equal(third.filter(m => m.type === "RECORD").length, 5);
  assert.equal(third.at(-1).state.mako.hasMore, false);
});

test("a chunk also stops at its byte budget, after a whole page, and resumes there", async () => {
  const dir = tmp();
  const config = writeJson(dir, "config.json", { apiKey: "good-key" });
  // One RECORD line of the fixture is about 140 bytes, so 10 records (one
  // page) pass a 1-byte budget: the chunk ends after the first page, never
  // inside it, even with 10 pages allowed.
  const first = await protocol(["read", "--config", config, "--max-iterations", "10", "--max-bytes", "1"]);
  assert.equal(first.filter(m => m.type === "RECORD").length, 10);
  const firstState = first.at(-1).state;
  assert.equal(firstState.mako.hasMore, true);
  assert.deepEqual(firstState.stream.stream_state, { offset: 10 });

  // A budget of one page's bytes plus one stops after the second page.
  const recordBytes = first
    .filter(m => m.type === "RECORD")
    .reduce((n, m) => n + Buffer.byteLength(`${JSON.stringify(m)}\n`), 0);
  const second = await protocol(["read", "--config", config, "--max-bytes", String(recordBytes + 1)]);
  assert.equal(second.filter(m => m.type === "RECORD").length, 20);
  assert.deepEqual(second.at(-1).state.stream.stream_state, { offset: 20 });
  assert.equal(second.at(-1).state.mako.hasMore, true);

  // The last page ends the stream whatever the budget says.
  const third = await protocol([
    "read",
    "--config",
    config,
    "--state",
    writeJson(dir, "state.json", second.at(-1).state),
    "--max-bytes",
    "1",
  ]);
  assert.equal(third.filter(m => m.type === "RECORD").length, 5);
  assert.equal(third.at(-1).state.mako.hasMore, false);
});

test("log lines count toward the byte budget", async () => {
  const dir = tmp();
  const config = writeJson(dir, "config.json", { apiKey: "good-key", logEveryPage: "x".repeat(4000) });
  // Records of a page are about 1.4 KB; with a 4 KB log line per page a
  // 5 KB budget is crossed on the first page by the log alone.
  const messages = await protocol(["read", "--config", config, "--max-bytes", "5000"]);
  assert.equal(messages.filter(m => m.type === "RECORD").length, 10);
  assert.equal(messages.at(-1).state.mako.hasMore, true);
});

test("a connector that omits hasMore is not failed by the byte budget", async () => {
  const dir = tmp();
  const config = writeJson(dir, "config.json", { apiKey: "good-key", omitHasMore: true });
  const messages = await protocol(["read", "--config", config, "--max-bytes", "1"]);
  assert.equal(messages.some(m => m.type === "TRACE"), false);
  // It stops at the page, with state to resume from.
  assert.equal(messages.filter(m => m.type === "RECORD").length, 10);
  const state = messages.at(-1).state;
  assert.equal(state.mako.hasMore, true);
  assert.deepEqual(state.stream.stream_state, { offset: 10 });
});

test("a connector without hasMore whose state does not move fails instead of looping", async () => {
  const dir = tmp();
  const config = writeJson(dir, "config.json", { apiKey: "good-key", omitHasMore: true, frozenState: true });
  const first = await protocol(["read", "--config", config, "--max-bytes", "1"]);
  // Chunk 1 stops with its state, as any capped chunk does.
  const state = writeJson(dir, "state.json", first.at(-1).state);
  // Chunk 2 starts there and gets the same state back: it fails loudly.
  const second = await protocol(["read", "--config", config, "--state", state, "--max-bytes", "1"], {
    expectFailure: true,
  });
  const trace = second.find(m => m.type === "TRACE");
  assert.match(trace.trace.error.message, /state unchanged/);
});

test("a catalog restricts which streams are read", async () => {
  const dir = tmp();
  const config = writeJson(dir, "config.json", { apiKey: "good-key" });
  const catalog = writeJson(dir, "catalog.json", {
    streams: [{ stream: { name: "nonexistent" }, sync_mode: "full_refresh" }],
  });
  const messages = await protocol(["read", "--config", config, "--catalog", catalog]);
  assert.equal(messages.filter(m => m.type === "RECORD").length, 0);
});

test("an unknown command fails loudly, as a TRACE error", async () => {
  const messages = await protocol(["frobnicate"], { expectFailure: true });
  const trace = messages.find(m => m.type === "TRACE");
  assert.equal(trace.trace.type, "ERROR");
  assert.match(trace.trace.error.message, /Unknown command/);
});

test("parseArgs takes flags with and without values", () => {
  assert.deepEqual(parseArgs(["read", "--config", "c.json", "--verbose"]), {
    command: "read",
    options: { config: "c.json", verbose: true },
  });
});

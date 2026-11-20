/**
 * The boxed Close connector folder (`connectors/close/`): checks that hold
 * the folder to itself, kept after the in-process connector was removed.
 *
 * - the folder is a node connector with 22 entities;
 * - the folder reads the replay cassettes into 50 golden files, byte for
 *   byte: the default read and one-page-per-chunk read of 22 entities, the
 *   incremental read of 5 Search entities, and the outcome of 86 webhook
 *   events (rewrite them, after an intended change, with
 *   `node connectors/close/fixtures/golden.mjs --write`; rebuild the
 *   cassettes with `--record`);
 * - the config holds the API key and nothing else, and the key goes only to
 *   Close or a loopback test server;
 * - the folder's source reads no environment variable;
 * - `check` accepts a valid key and refuses a revoked one;
 * - a lead's `first_source` is stored as `source`;
 * - the cassettes hold no key, no signing key and no real address.
 *
 * The harness lives with the folder: connectors/close/fixtures/harness.mjs.
 * Sits at the top of api/src/connectors, not in a close/ folder, which the
 * connector family boundary guard would treat as a family.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { parseConnectorFile } from "./workspace/connector-file";
import { connectionSpecificationToForm } from "./workspace/spec-translation";
import {
  CASSETTE_DIR,
  FOLDER,
  ensureFolderInstalled,
  runFolderCommand,
  startReplayServer,
  type ReplayServer,
} from "../../../connectors/close/fixtures/harness.mjs";

/** golden.mjs has a top-level await, so it loads at run time. */
const loadGolden = () =>
  import("../../../connectors/close/fixtures/golden.mjs");

let server: ReplayServer;
let streams: Array<Record<string, any>> = [];
let spec: Record<string, any> | undefined;

before(async () => {
  ensureFolderInstalled();
  server = await startReplayServer();
  const discover = await runFolderCommand("discover", {
    config: { api_key: "api_test_schema", __base_url: server.url },
  });
  streams =
    discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? [];
  spec = (await runFolderCommand("spec")).messages.find(
    m => m.type === "SPEC",
  )?.spec;
});

after(async () => {
  await server?.close();
});

void test("connector.yaml is a node folder with its entry", () => {
  const parsed = parseConnectorFile(
    fs.readFileSync(path.join(FOLDER, "connector.yaml"), "utf8"),
  );
  assert.ok(parsed.ok, parsed.ok ? "" : parsed.reason);
  assert.equal(parsed.value.runtime, "node");
  assert.equal(parsed.value.entry, "connector.ts");
});

void test("users re-reads every membership, so it declares no incremental mode", () => {
  const entities = spec?.mako?.entities ?? {};
  assert.equal(entities.users?.incremental, undefined);
  // custom_fields and the 5 Search entities keep theirs.
  assert.equal(entities.custom_fields?.incremental, "native");
  assert.equal(entities.leads?.incremental, "native");
  // Its cursor still stamps the record time.
  const users = streams.find(s => s.name === "users");
  assert.deepEqual(users?.default_cursor_field, ["date_updated"]);
});

/** Every file under golden/, as paths relative to it. */
function goldenFiles(dir: string, prefix = ""): string[] {
  return fs
    .readdirSync(dir, { withFileTypes: true })
    .flatMap(entry =>
      entry.isDirectory()
        ? goldenFiles(path.join(dir, entry.name), `${prefix}${entry.name}/`)
        : [`${prefix}${entry.name}`],
    );
}

/** A golden file, parsed. */
const golden = async (file: string) => {
  const { GOLDEN_DIR } = await loadGolden();
  return JSON.parse(fs.readFileSync(path.join(GOLDEN_DIR, file), "utf8"));
};

void test("22 entities, each with a label and its golden files", async () => {
  const { GOLDEN_DIR, SINCE_ENTITIES, goldenFile } = await loadGolden();
  const names = streams.map(s => s.name);
  assert.equal(names.length, 22);
  for (const name of names) {
    assert.ok(spec?.mako?.entities?.[name]?.label, `${name} has a label`);
  }
  assert.deepEqual(
    goldenFiles(GOLDEN_DIR).sort(),
    [
      ...names.map(goldenFile),
      ...names.map(n => `chunked/${goldenFile(n)}`),
      ...SINCE_ENTITIES.map(n => `since/${goldenFile(n)}`),
      "webhooks.json",
    ].sort(),
  );
});

void test("the folder reads the cassettes into the golden files, byte for byte", async () => {
  const { GOLDEN_DIR, buildGolden } = await loadGolden();
  const actual = await buildGolden();
  assert.equal(Object.keys(actual).length, 22 + 22 + 5 + 1);
  for (const [file, text] of Object.entries(actual)) {
    const expected = fs.readFileSync(path.join(GOLDEN_DIR, file), "utf8");
    assert.equal(
      text,
      expected,
      `${file} differs from fixtures/golden/${file}`,
    );
  }
});

void test("every entity's default read has rows, custom_objects aside", async () => {
  const { goldenFile } = await loadGolden();
  for (const { name } of streams) {
    const rows = await golden(goldenFile(name));
    // custom_objects reads nothing: Close needs a lead id per object.
    if (name !== "custom_objects") assert.ok(rows.length > 0, name);
  }
});

void test("an incremental read from SINCE returns only newer rows, and fewer than the full read", async () => {
  const { SINCE_ENTITIES, goldenFile } = await loadGolden();
  const { SINCE } =
    await import("../../../connectors/close/fixtures/harness.mjs");
  const expected: Record<string, [number, number]> = {
    leads: [35, 215],
    contacts: [11, 80],
    opportunities: [5, 50],
    "activities:Call": [45, 231],
    "activities:Email": [9, 30],
  };
  assert.deepEqual(SINCE_ENTITIES.sort(), Object.keys(expected).sort());
  for (const entity of SINCE_ENTITIES) {
    const since = await golden(`since/${goldenFile(entity)}`);
    const full = await golden(goldenFile(entity));
    assert.deepEqual([since.length, full.length], expected[entity], entity);
    assert.ok(since.length < full.length, entity);
    for (const row of since) {
      assert.ok(row.date_updated >= SINCE, `${entity} ${row.id}`);
    }
  }
});

void test("one page per chunk reads every row in more than one chunk, and ends", async () => {
  const leads = await golden("chunked/leads.json");
  assert.equal(leads.rowCount, 215);
  assert.equal(leads.chunks.length, 12);
  assert.equal(leads.chunks.at(-1).hasMore, false);
  assert.ok(leads.chunks.slice(0, -1).every((c: any) => c.hasMore));
  const { goldenFile } = await loadGolden();
  for (const { name } of streams) {
    const chunked = await golden(`chunked/${goldenFile(name)}`);
    assert.equal(chunked.chunks.at(-1).hasMore, false, name);
    assert.equal(
      chunked.chunks.reduce((n: number, c: any) => n + c.records, 0),
      chunked.rowCount,
      name,
    );
  }
});

void test("the 86 subscribed events give 93 records, 1 failed extraction and 1 unmapped event", async () => {
  const webhooks = await golden("webhooks.json");
  assert.equal(webhooks.events.length, 86);
  const counts: Record<string, number> = {};
  for (const o of webhooks.outcomes) {
    counts[o.outcome] =
      (counts[o.outcome] ?? 0) +
      (o.outcome === "records" ? o.records.length : 1);
  }
  assert.deepEqual(counts, { records: 93, extract_failed: 1, unmapped: 1 });
});

void test("the config form is the API key and nothing else", () => {
  const form = connectionSpecificationToForm(spec?.connectionSpecification);
  assert.deepEqual(
    form.fields.map((f: { name: string }) => f.name),
    ["api_key"],
  );
  assert.equal(spec?.connectionSpecification?.additionalProperties, false);
  assert.deepEqual(spec?.connectionSpecification?.required, ["api_key"]);
});

void test("the key is never sent to a host other than Close or loopback", async () => {
  for (const [baseUrl, message] of [
    ["https://attacker.example/api/v1", /must be https:\/\/api\.close\.com/],
    ["http://api.close.com/api/v1", /must be https:\/\/api\.close\.com/],
    ["not a url", /not a URL/],
  ] as const) {
    const run = await runFolderCommand("check", {
      config: { api_key: "api_test_host", __base_url: baseUrl },
    });
    const status = run.messages.find(
      m => m.type === "CONNECTION_STATUS",
    )?.connectionStatus;
    assert.equal(status?.status, "FAILED", baseUrl);
    assert.match(String(status?.message), message, baseUrl);
  }
  assert.deepEqual(server.requests("api_test_host"), []);
});

void test("the folder's source reads no environment variable", () => {
  const sources = fs
    .readdirSync(FOLDER)
    .filter(f => f.endsWith(".ts") && !f.endsWith(".d.ts"));
  assert.ok(sources.length > 0);
  for (const file of sources) {
    const text = fs.readFileSync(path.join(FOLDER, file), "utf8");
    assert.doesNotMatch(text, /process\.env/, file);
  }
});

void test("check accepts a valid key and refuses a revoked one", async () => {
  const statusOf = async (apiKey: string) =>
    (
      await runFolderCommand("check", {
        config: { api_key: apiKey, __base_url: server.url },
      })
    ).messages.find(m => m.type === "CONNECTION_STATUS")?.connectionStatus;
  assert.equal((await statusOf("api_test_valid"))?.status, "SUCCEEDED");
  const revoked = await statusOf("api_test_revoked");
  assert.equal(revoked?.status, "FAILED");
  assert.match(String(revoked?.message), /401/);
});

void test("a lead's first_source is stored as source; an explicit source wins", async () => {
  const load = (file: string) =>
    import(pathToFileURL(path.join(FOLDER, file)).href);
  const normalize = (await load("records.ts")).normalizeCloseLeadRecord as (
    record: Record<string, unknown>,
  ) => Record<string, unknown>;
  const fields = (await load("catalog.ts")).CLOSE_SEARCH_BASE_FIELDS
    .lead as string[];
  assert.ok(fields.includes("first_source"));

  const fromSearch = normalize({ id: "lead_1", first_source: "api" });
  assert.equal(fromSearch.source, "api");
  assert.ok(!("first_source" in fromSearch));

  const explicit = normalize({
    id: "lead_1",
    source: "ui",
    first_source: "api",
  });
  assert.equal(explicit.source, "ui");
  assert.ok(!("first_source" in explicit));

  assert.equal(
    normalize({ id: "lead_1", source: null, first_source: "api" }).source,
    null,
  );
  assert.ok(!("source" in normalize({ id: "lead_1" })));
});

void test("the cassettes walk the error paths: a cursor limit and a refused selection", () => {
  const read = (file: string) =>
    fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
  assert.match(read("activities_Call.json"), /"field-errors":\{"cursor"/);
  assert.match(read("leads.json"), /"field-errors":\{"_fields"/);
});

void test("the cassettes hold no key, no signing key and no real address", () => {
  for (const file of fs.readdirSync(CASSETTE_DIR)) {
    const text = fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
    assert.doesNotMatch(text, /api_[A-Za-z0-9]{20,}|signature_key/, file);
    for (const email of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) {
      assert.match(email, /@example\.com$/, `${file}: ${email}`);
    }
  }
});

/**
 * The boxed Close connector folder (`connectors/close/`): checks that hold
 * the folder to itself, kept after the in-process connector was removed.
 *
 * - the folder is a node connector with 22 entities, one golden file each;
 * - every entity reads the replay cassettes into its golden rows, byte for
 *   byte (rewrite them, after an intended change, with
 *   `node connectors/close/fixtures/golden.mjs --write`);
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

void test("22 entities, each with a label and a golden file", async () => {
  const { GOLDEN_DIR, goldenFile } = await loadGolden();
  const names = streams.map(s => s.name);
  assert.equal(names.length, 22);
  for (const name of names) {
    assert.ok(spec?.mako?.entities?.[name]?.label, `${name} has a label`);
  }
  assert.deepEqual(
    fs.readdirSync(GOLDEN_DIR).sort(),
    names.map(goldenFile).sort(),
  );
});

void test("the folder reads the cassettes into the golden rows, byte for byte", async () => {
  const { GOLDEN_DIR, buildGolden, goldenFile } = await loadGolden();
  const actual = await buildGolden();
  assert.deepEqual(Object.keys(actual).sort(), streams.map(s => s.name).sort());
  for (const [entity, text] of Object.entries(actual)) {
    const expected = fs.readFileSync(
      path.join(GOLDEN_DIR, goldenFile(entity)),
      "utf8",
    );
    // custom_objects reads nothing: Close needs a lead id per object.
    if (entity !== "custom_objects") {
      assert.ok(JSON.parse(expected).length > 0, `${entity} golden is empty`);
    }
    assert.equal(
      text,
      expected,
      `${entity} differs from fixtures/golden/${goldenFile(entity)}`,
    );
  }
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

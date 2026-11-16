/**
 * Parity between this in-process Stripe connector and its port to a connector
 * folder (`connectors/stripe/`, RFC connector-runtime iteration 4).
 *
 * Both run against the same recorded Stripe responses, served locally, with
 * the real `stripe` package on each side. Every entity is read in three
 * scenarios (one page per chunk, the default chunk, incremental `since`) and
 * compared on row count, keys, order, columns, a checksum per row, the chunk
 * states and the exact requests sent. The schemas, the credential form and
 * `check` are compared too.
 *
 * The harness lives with the folder: connectors/stripe/fixtures/harness.mjs.
 * Re-record or print the table with connectors/stripe/fixtures/parity.mjs.
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { StripeConnector } from "./connector";
import { MAKO_SYSTEM_FIELDS } from "../base/BaseConnector";
import { parseConnectorFile } from "../workspace/connector-file";
import {
  connectionSpecificationToForm,
  jsonSchemaToEntitySchema,
} from "../workspace/spec-translation";
import {
  CASSETTE_DIR,
  FOLDER,
  checkParity,
  compareEntitySchema,
  compareForm,
  compareRuns,
  ensureFolderInstalled,
  formatReport,
  runFolderCommand,
  runParity,
  startReplayServer,
  type ReplayServer,
  type StripeTestConfig,
} from "../../../../connectors/stripe/fixtures/harness.mjs";

const makeInProcess = (config: StripeTestConfig) =>
  new StripeConnector({
    id: "ds_parity",
    name: "Stripe parity",
    type: "stripe",
    config,
  } as any);

const ENTITIES = makeInProcess({
  api_key: "sk_test_list",
  api_base_url: "",
}).getAvailableEntities();

let server: ReplayServer;
let streams: Array<Record<string, any>> = [];
let spec: Record<string, any> | undefined;

before(async () => {
  ensureFolderInstalled();
  server = await startReplayServer();
  const discover = await runFolderCommand("discover", {
    config: { api_key: "sk_test_schema" },
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

void test("the folder pins the stripe package the API resolves", () => {
  const folderPackage = JSON.parse(
    fs.readFileSync(path.join(FOLDER, "package.json"), "utf8"),
  );
  const lock = JSON.parse(
    fs.readFileSync(path.join(FOLDER, "package-lock.json"), "utf8"),
  );
  const apiStripe = JSON.parse(
    fs.readFileSync(
      path.resolve(__dirname, "../../../node_modules/stripe/package.json"),
      "utf8",
    ),
  ).version;
  assert.equal(folderPackage.dependencies.stripe, apiStripe);
  assert.equal(lock.packages["node_modules/stripe"].version, apiStripe);
});

void test("same entities, labels and credential form", () => {
  assert.deepEqual(
    streams.map(s => s.name),
    ENTITIES,
  );
  const metadata = makeInProcess({
    api_key: "sk_test_list",
    api_base_url: "",
  }).getEntityMetadata();
  for (const { name, label } of metadata) {
    assert.equal(spec?.mako?.entities?.[name]?.label, label, name);
  }
  const form = compareForm(
    StripeConnector.getConfigSchema().fields,
    connectionSpecificationToForm(spec?.connectionSpecification).fields,
  );
  assert.ok(form.ok, JSON.stringify(form, null, 2));
});

void test("same schema for every entity, system fields aside", async () => {
  const system = new Set(Object.keys(MAKO_SYSTEM_FIELDS));
  const connector = makeInProcess({
    api_key: "sk_test_list",
    api_base_url: "",
  });
  for (const entity of ENTITIES) {
    const result = compareEntitySchema(
      await connector.resolveSchema(entity),
      jsonSchemaToEntitySchema(
        entity,
        streams.find(s => s.name === entity),
      ),
      system,
    );
    assert.ok(result.ok, `${entity}: ${JSON.stringify(result)}`);
    assert.equal(result.systemFields, system.size, entity);
  }
});

void test("check agrees on a valid key and on a revoked one", async () => {
  const outcomes = await checkParity({ makeInProcess, server });
  assert.deepEqual(
    outcomes.map(o => [o.variant, o.inProcess, o.folder, o.requestsEqual]),
    [
      ["valid", true, true, true],
      ["revoked", false, false, true],
    ],
  );
});

void test("every entity reads the same rows, chunks and requests", async () => {
  const results = await runParity({
    entities: ENTITIES,
    makeInProcess,
    server,
  });
  const report = formatReport(results);
  assert.equal(results.length, ENTITIES.length * 3);
  assert.deepEqual(
    results.filter(r => !r.ok).map(r => `${r.scenario}/${r.entity}`),
    [],
    report,
  );
  assert.deepEqual(server.misses, []);
  // The fixtures exercise more than one page, chunk boundaries and child lists.
  const chunked = (entity: string) =>
    results.find(r => r.scenario === "chunked" && r.entity === entity);
  assert.equal(chunked("customers")?.chunks[0], 2);
  assert.equal(chunked("payout_balance_transactions")?.rows[0], 212);
  assert.equal(chunked("customer_balance_transactions")?.rows[0], 126);
  assert.equal(chunked("setup_intents")?.rows[0], 0);
});

void test("the comparison catches a changed field, a lost row and another request", () => {
  const rows = [
    { id: "a", amount: 1 },
    { id: "b", amount: 2 },
  ];
  const base = {
    rows,
    chunks: [{ cursor: "b", hasMore: false }],
    requests: ["GET /v1/x?limit=100"],
  };
  assert.ok(compareRuns(base, structuredClone(base)).ok);

  const changed = structuredClone(base);
  changed.rows[1].amount = 3;
  assert.deepEqual(compareRuns(base, changed).checksumMismatches, ["b"]);

  const lost = { ...structuredClone(base), rows: [rows[0]] };
  assert.equal(compareRuns(base, lost).keys, false);

  const other = {
    ...structuredClone(base),
    requests: ["GET /v1/x?limit=100&status=all"],
  };
  assert.equal(compareRuns(base, other).requestsEqual, false);
});

void test("the cassettes hold no key or signing secret", () => {
  for (const file of fs.readdirSync(CASSETTE_DIR)) {
    const text = fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
    assert.doesNotMatch(text, /\b(sk|rk)_(live|test)_|whsec_/, file);
  }
});

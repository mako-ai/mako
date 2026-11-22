/**
 * The boxed Calendly connector folder (`connectors/calendly/`): checks that
 * hold the folder to itself, kept after the in-process connector was
 * removed.
 *
 * - the folder is a node connector with 7 entities and a 2-field credential
 *   form;
 * - the folder reads the replay cassettes into 32 golden files, byte for
 *   byte: the default, incremental, one-page-per-chunk and two-rows-a-page
 *   reads of 7 entities, the rate-limited read of 3, and the outcome of 9
 *   webhook events (rewrite them, after an intended change, with
 *   `node connectors/calendly/fixtures/golden.mjs --write`; rebuild the
 *   cassettes with `--record`);
 * - the token goes only to Calendly or a loopback test server;
 * - `check` accepts a valid token and refuses a revoked one;
 * - the folder declares Calendly's signature scheme and delivery ids;
 * - the cassettes hold no token and no real address.
 *
 * The harness lives with the folder: connectors/calendly/fixtures/harness.mjs.
 * Sits at the top of api/src/connectors, not in a calendly/ folder, which the
 * connector family boundary guard would treat as a family.
 *
 * Run: node --import tsx src/connectors/calendly-folder.test.ts
 */
import { after, before, test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { parseConnectorFile } from "./workspace/connector-file";
import { connectionSpecificationToForm } from "./workspace/spec-translation";
import {
  CASSETTE_DIR,
  FOLDER,
  RATE_LIMIT_ENTITIES,
  ensureFolderInstalled,
  runFolderCommand,
  startReplayServer,
  type ReplayServer,
} from "../../../connectors/calendly/fixtures/harness.mjs";

/** golden.mjs has a top-level await, so it loads at run time. */
const loadGolden = () =>
  import("../../../connectors/calendly/fixtures/golden.mjs");

const ENTITIES = [
  "organizations",
  "users",
  "groups",
  "event_types",
  "scheduled_events",
  "invitees",
  "contacts",
];

let server: ReplayServer;
let streams: Array<Record<string, any>> = [];
let spec: Record<string, any> | undefined;

before(async () => {
  ensureFolderInstalled();
  server = await startReplayServer();
  const discover = await runFolderCommand("discover", {
    config: { access_token: "cal_test_schema" },
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

void test("7 entities in order, each with a label, and the token form", () => {
  assert.deepEqual(
    streams.map(s => s.name),
    ENTITIES,
  );
  for (const name of ENTITIES) {
    assert.ok(spec?.mako?.entities?.[name]?.label, `${name} has a label`);
  }
  const form = connectionSpecificationToForm(spec?.connectionSpecification);
  assert.deepEqual(
    form.fields.map((f: { name: string }) => f.name),
    ["access_token", "api_base_url"],
  );
});

void test("the golden files cover 7 entities in 4 scenarios, 3 entities rate-limited, and the webhooks", async () => {
  const { GOLDEN_DIR } = await loadGolden();
  assert.deepEqual(
    goldenFiles(GOLDEN_DIR).sort(),
    [
      ...["default", "since", "chunked", "small-pages"].flatMap(scenario =>
        ENTITIES.map(e => `${scenario}/${e}.json`),
      ),
      ...RATE_LIMIT_ENTITIES.map(e => `rate-limited/${e}.json`),
      "webhooks.json",
    ].sort(),
  );
});

void test("the folder reads the cassettes into the golden files, byte for byte", async () => {
  const { GOLDEN_DIR, buildGolden } = await loadGolden();
  const actual = await buildGolden();
  assert.equal(Object.keys(actual).length, 7 * 4 + 3 + 1);
  for (const [file, text] of Object.entries(actual)) {
    const expected = fs.readFileSync(path.join(GOLDEN_DIR, file), "utf8");
    assert.equal(
      text,
      expected,
      `${file} differs from fixtures/golden/${file}`,
    );
  }
});

void test("the chunked and two-row reads hold the same rows as the default read", async () => {
  for (const entity of ENTITIES) {
    const full = await golden(`default/${entity}.json`);
    for (const scenario of ["chunked", "small-pages"]) {
      const run = await golden(`${scenario}/${entity}.json`);
      assert.equal(run.rowCount, full.rows.length, `${scenario}/${entity}`);
      assert.equal(run.chunks.at(-1).hasMore, false, `${scenario}/${entity}`);
      assert.ok(run.chunks.slice(0, -1).every((c: any) => c.hasMore));
    }
  }
  // 210 events, 3 pages of 100: invitees walk the start-time keyset across
  // a page boundary that 7 events share, and read no invitee twice.
  const invitees = await golden("default/invitees.json");
  assert.equal(invitees.rows.length, 477);
  assert.equal(new Set(invitees.rows.map((r: any) => r.id)).size, 477);
  // One page per chunk: every events page and every wave ends a chunk.
  assert.equal((await golden("chunked/invitees.json")).chunks.length, 28);
  // Two rows a page: 105 one-page chunks of scheduled events.
  assert.equal(
    (await golden("small-pages/scheduled_events.json")).chunks.length,
    105,
  );
});

void test("an incremental read from SINCE returns fewer rows, and only dated ones where it filters", async () => {
  const { SINCE } =
    await import("../../../connectors/calendly/fixtures/harness.mjs");
  const expected: Record<string, [number, number]> = {
    invitees: [160, 477],
    scheduled_events: [89, 210],
    groups: [1, 4],
    contacts: [3, 5],
    users: [2, 5],
    event_types: [2, 7],
  };
  for (const [entity, [since, full]] of Object.entries(expected)) {
    const run = await golden(`since/${entity}.json`);
    assert.deepEqual(
      [run.rows.length, (await golden(`default/${entity}.json`)).rows.length],
      [since, full],
      entity,
    );
  }
  for (const entity of ["groups", "contacts", "users", "event_types"]) {
    for (const row of (await golden(`since/${entity}.json`)).rows) {
      assert.ok(row.updated_at >= SINCE, `${entity} ${row.id}`);
    }
  }
});

void test("a rate-limited read answers every request 429 once and reads the same rows", async () => {
  for (const entity of ["users", "scheduled_events"]) {
    const limited = await golden(`rate-limited/${entity}.json`);
    const full = await golden(`default/${entity}.json`);
    assert.equal(limited.rowCount, full.rows.length, entity);
    assert.equal(limited.requestCount, 2 * full.requestCount, entity);
  }
  const invitees = await golden("rate-limited/invitees.json");
  assert.equal(invitees.rowCount, 477);
  assert.ok(invitees.requestCount > 206);
});

void test("the 5 subscribed events give 9 records, 2 failed extractions and 1 unmapped event", async () => {
  const webhooks = await golden("webhooks.json");
  assert.deepEqual(webhooks.events, [
    "invitee.created",
    "invitee.canceled",
    "invitee_no_show.created",
    "event_type.created",
    "event_type.updated",
  ]);
  assert.equal(webhooks.eventsForEntities.length, 6);
  const counts: Record<string, number> = {};
  for (const o of webhooks.outcomes) {
    counts[o.outcome] =
      (counts[o.outcome] ?? 0) +
      (o.outcome === "records" ? o.records.length : 1);
  }
  assert.deepEqual(counts, { records: 9, extract_failed: 2, unmapped: 1 });
});

void test("the folder declares Calendly's signature scheme and delivery ids", () => {
  assert.deepEqual(spec?.mako?.webhooks, {
    verification: {
      scheme: "stripe-v1",
      signatureHeader: "calendly-webhook-signature",
      secretEncoding: "utf8",
      toleranceSeconds: 180,
    },
    events: [
      "invitee.created",
      "invitee.canceled",
      "invitee_no_show.created",
      "event_type.created",
      "event_type.updated",
    ],
    eventIdPath: ["created_at", "payload.uri"],
    eventTypePath: "event",
  });
});

void test("the token is never sent to a host other than Calendly or loopback", async () => {
  for (const [baseUrl, message] of [
    ["https://attacker.example", /must be https:\/\/api\.calendly\.com/],
    ["http://api.calendly.com", /must be https:\/\/api\.calendly\.com/],
    ["not a url", /not a URL/],
  ] as const) {
    const run = await runFolderCommand("check", {
      config: { access_token: "cal_test_host", api_base_url: baseUrl },
    });
    const status = run.messages.find(
      m => m.type === "CONNECTION_STATUS",
    )?.connectionStatus;
    assert.equal(status?.status, "FAILED", baseUrl);
    assert.match(String(status?.message), message, baseUrl);
  }
  assert.deepEqual(server.requests("cal_test_host"), []);
});

void test("check accepts a valid token and refuses a revoked one", async () => {
  const statusOf = async (token: string) =>
    (
      await runFolderCommand("check", {
        config: { access_token: token, api_base_url: server.url },
      })
    ).messages.find(m => m.type === "CONNECTION_STATUS")?.connectionStatus;
  assert.equal((await statusOf("cal_test_valid"))?.status, "SUCCEEDED");
  const revoked = await statusOf("cal_test_revoked");
  assert.equal(revoked?.status, "FAILED");
  assert.match(String(revoked?.message), /401/);
});

void test("the cassettes walk the error path: an event whose invitees answer 404", () => {
  const read = (file: string) =>
    fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
  assert.match(read("invitees.json"), /"status":404/);
});

void test("the cassettes hold no token and no real address", () => {
  for (const file of fs.readdirSync(CASSETTE_DIR)) {
    const text = fs.readFileSync(path.join(CASSETTE_DIR, file), "utf8");
    assert.doesNotMatch(text, /cal_test_|Bearer|signing_key/, file);
    for (const email of text.match(/[\w.+-]+@[\w-]+\.[\w.]+/g) ?? []) {
      assert.match(email, /@example\.com$/, `${file}: ${email}`);
    }
  }
});

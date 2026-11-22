/**
 * The boxed Claap connector folder (`connectors/claap/`): checks that hold
 * the folder to itself, kept after the in-process connector was removed.
 *
 * - the folder is a node connector with 3 entities;
 * - the folder reads the replay cassettes into 13 golden files plus the
 *   webhook outcomes, byte for byte: the default, incremental, 3-day
 *   lookback and 2-recordings-a-page reads of 3 entities, and a box batch of
 *   10 fixture deliveries with transcripts on and off (rewrite them, after
 *   an intended change, with `node connectors/claap/fixtures/golden.mjs
 *   --write`; rebuild the cassettes with `--record`);
 * - a daily quota that runs low checkpoints `recordings` mid-page, then
 *   fails the next chunk with the quota error;
 * - a request answered 429 is retried once and the rows stay the same;
 * - `check` accepts a valid key and refuses a revoked one;
 * - the webhook declaration is a shared secret, an event id and a type;
 * - past its budget a webhook batch defers events, never answering them
 *   unfilled;
 * - the cassettes hold no real key and walk the error paths.
 *
 * The harness lives with the folder: connectors/claap/fixtures/harness.mjs.
 * Sits at the top of api/src/connectors, not in a claap/ folder, which the
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
  declaredWebhookIdentity,
  declaredWebhookVerification,
} from "./workspace/webhook-verification";
import {
  CASSETTE_DIR,
  ENTITIES,
  FOLDER,
  QUOTA_SCENARIO,
  RATE_LIMIT_SCENARIO,
  ensureFolderInstalled,
  readFolder,
  runFolderCommand,
  startReplayServer,
  type Run,
  type ReplayServer,
} from "../../../connectors/claap/fixtures/harness.mjs";
import { buildWebhookDeliveries } from "../../../connectors/claap/fixtures/webhook-events.mjs";

/** golden.mjs has a top-level await, so it loads at run time. */
const loadGolden = () =>
  import("../../../connectors/claap/fixtures/golden.mjs");

let server: ReplayServer;
let streams: Array<Record<string, any>> = [];
let spec: Record<string, any> | undefined;

before(async () => {
  ensureFolderInstalled();
  server = await startReplayServer();
  const discover = await runFolderCommand("discover", {
    config: { api_key: "api_test_schema", api_base_url: server.url },
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

void test("3 entities in order, each with a label and its golden files", async () => {
  const { GOLDEN_DIR, GOLDEN_SCENARIOS } = await loadGolden();
  const names = streams.map(s => s.name);
  assert.deepEqual(names, ENTITIES);
  assert.deepEqual(names, ["recordings", "recording_transcripts", "workspace"]);
  for (const name of names) {
    assert.ok(spec?.mako?.entities?.[name]?.label, `${name} has a label`);
  }
  // recordings and transcripts anchor on creation, so a poll misses updates
  // to old rows; the workspace row has no anchor.
  assert.deepEqual(
    names.map(n => spec?.mako?.entities?.[n]?.incremental ?? "none"),
    ["created-anchor", "created-anchor", "none"],
  );
  assert.deepEqual(
    goldenFiles(GOLDEN_DIR).sort(),
    [
      ...GOLDEN_SCENARIOS.flatMap(s => names.map(n => `${s}/${n}.json`)),
      "webhooks.json",
    ].sort(),
  );
});

void test("the folder reads the cassettes into the golden files, byte for byte", async () => {
  const { GOLDEN_DIR, buildGolden } = await loadGolden();
  const actual = await buildGolden();
  assert.equal(Object.keys(actual).length, 4 * 3 + 1);
  for (const [file, text] of Object.entries(actual)) {
    const expected = fs.readFileSync(path.join(GOLDEN_DIR, file), "utf8");
    assert.equal(
      text,
      expected,
      `${file} differs from fixtures/golden/${file}`,
    );
  }
});

void test("the default read holds 21 recordings, 29 transcripts and 1 workspace row", async () => {
  // 23 recordings, 2 skipped (a 404 and a Ready one without aiFields).
  assert.equal((await golden("default/recordings.json")).length, 21);
  // 29 transcripts of 23 recordings: signed links, 2 API fallbacks, 1 failure.
  const transcripts = await golden("default/recording_transcripts.json");
  assert.equal(transcripts.length, 29);
  assert.deepEqual(
    Object.entries(
      transcripts.reduce((n: Record<string, number>, t: any) => {
        n[t.fetchStatus] = (n[t.fetchStatus] ?? 0) + 1;
        return n;
      }, {}),
    ).sort(),
    [
      ["empty", 1],
      ["failed", 1],
      ["ok", 27],
    ],
  );
  assert.equal((await golden("default/workspace.json")).length, 1);
  // Download times are masked, so no golden file holds a clock.
  for (const row of transcripts) assert.equal(row.fetchedAt, "<fetchedAt>");
});

void test("an incremental read from SINCE returns fewer rows than the full read, and a 3-day lookback 1 more", async () => {
  const { SINCE } =
    await import("../../../connectors/claap/fixtures/harness.mjs");
  const count = async (dir: string, entity: string) =>
    (await golden(`${dir}/${entity}.json`)).length;
  assert.equal(await count("since", "recordings"), 12);
  assert.equal(await count("since", "recording_transcripts"), 17);
  assert.equal(await count("since", "workspace"), 1);
  assert.equal(await count("lookback", "recordings"), 13);
  assert.ok(
    (await count("since", "recordings")) <
      (await count("default", "recordings")),
  );
  for (const row of await golden("since/recordings.json")) {
    assert.ok(row.createdAt >= SINCE, row.id);
  }
});

void test("two recordings a page, one page per chunk, reads 21 recordings in 12 chunks and ends", async () => {
  const recordings = await golden("chunked/recordings.json");
  assert.equal(recordings.rowCount, 21);
  assert.equal(recordings.chunks.length, 12);
  assert.equal(recordings.chunks.at(-1).hasMore, false);
  assert.ok(recordings.chunks.slice(0, -1).every((c: any) => c.hasMore));
  for (const name of ENTITIES) {
    const chunked = await golden(`chunked/${name}.json`);
    assert.equal(chunked.chunks.at(-1).hasMore, false, name);
    assert.equal(
      chunked.rowCount,
      (await golden(`default/${name}.json`)).length,
      name,
    );
  }
});

void test("the 10 fixture deliveries give 6 record sets, 1 skipped, 2 failed extractions and 1 unmapped event", async () => {
  const webhooks = await golden("webhooks.json");
  const deliveries = buildWebhookDeliveries();
  for (const key of ["transcripts", "transcriptsOff"]) {
    const outcomes = webhooks[key];
    assert.deepEqual(
      outcomes.map((o: any) => o.eventId),
      deliveries.map(d => d.event.eventId),
      key,
    );
    const counts: Record<string, number> = {};
    for (const o of outcomes) counts[o.outcome] = (counts[o.outcome] ?? 0) + 1;
    assert.deepEqual(
      counts,
      { records: 6, skipped: 1, extract_failed: 2, unmapped: 1 },
      key,
    );
  }
  const entities = (key: string) =>
    webhooks[key].flatMap((o: any) =>
      (o.records ?? []).map((r: any) => r.entity),
    );
  // 9 transcript rows with transcripts on, none with them off.
  assert.equal(
    entities("transcripts").filter((e: string) => e === "recording_transcripts")
      .length,
    9,
  );
  assert.equal(
    entities("transcriptsOff").filter(
      (e: string) => e === "recording_transcripts",
    ).length,
    0,
  );
  assert.equal(
    entities("transcriptsOff").filter((e: string) => e === "recordings").length,
    6,
  );
});

void test("the config form is the API key, the base URL and the lookback window", () => {
  const form = connectionSpecificationToForm(spec?.connectionSpecification);
  assert.deepEqual(
    form.fields.map((f: { name: string }) => f.name),
    ["api_key", "api_base_url", "recordings_lookback_days"],
  );
  assert.equal(spec?.connectionSpecification?.additionalProperties, false);
  assert.deepEqual(spec?.connectionSpecification?.required, ["api_key"]);
});

void test("the webhook declaration is a shared secret, an event id and a type", () => {
  assert.deepEqual(spec?.mako?.webhooks?.events, [
    "recording_added",
    "recording_updated",
  ]);
  assert.deepEqual(declaredWebhookVerification(spec), {
    scheme: "shared-secret",
    secretHeader: "x-claap-webhook-secret",
  });
  assert.deepEqual(declaredWebhookIdentity(spec), {
    eventIdPath: "eventId",
    eventTypePath: "event.type",
  });
});

void test("check accepts a valid key and refuses a revoked one", async () => {
  const outcome = async (key: string) => {
    const run = await runFolderCommand("check", {
      config: { api_key: key, api_base_url: server.url },
    });
    return run.messages.find(m => m.type === "CONNECTION_STATUS")
      ?.connectionStatus?.status;
  };
  assert.equal(await outcome("api_test_check"), "SUCCEEDED");
  assert.equal(await outcome("api_test_revoked_check"), "FAILED");
});

void test("a request answered 429 once is retried: 56 requests, the same rows", async () => {
  const key = "api_test_ratelimit_recordings_check";
  const out: Run = { rows: [], chunks: [] };
  await readFolder(
    {
      entity: "recordings",
      config: {
        api_key: key,
        api_base_url: server.url,
        __page_size: RATE_LIMIT_SCENARIO.pageSize,
      },
      maxIterations: RATE_LIMIT_SCENARIO.maxIterations,
    },
    out,
  );
  assert.equal(out.rows.length, 21);
  // 5 list pages of 5 and 23 detail reads, each sent twice.
  assert.equal(server.requests(key).length, 56);
});

void test("a low daily quota checkpoints recordings mid-page, then fails the next chunk", async () => {
  const key = "api_test_quota_recordings_check";
  const out: Run = { rows: [], chunks: [] };
  await assert.rejects(
    readFolder(
      {
        entity: "recordings",
        config: {
          api_key: key,
          api_base_url: server.url,
          __page_size: QUOTA_SCENARIO.pageSize,
        },
        maxIterations: QUOTA_SCENARIO.maxIterations,
      },
      out,
    ),
    /daily API quota nearly used up/,
  );
  assert.equal(out.chunks.length, 1);
  assert.equal(out.chunks[0].hasMore, true);
  assert.equal(out.rows.length, 17);
});

const folderWebhooks = () =>
  import(pathToFileURL(path.join(FOLDER, "webhooks.ts")).href);

void test("past its budget a webhook read is deferred, never answered unfilled", async () => {
  const { handleClaapWebhookBatch } = await folderWebhooks();
  let clock = 0;
  const deliveries = buildWebhookDeliveries();
  const partial = deliveries.find(d => d.name === "partial: no source")!;
  const events = [partial.event, partial.event, partial.event].map((e, i) => ({
    ...e,
    eventId: `${e.eventId}_${i}`,
  }));
  const detail = partial.body.event.recording;
  const outcomes = await handleClaapWebhookBatch(
    {
      api: {
        get: async () => {
          clock += 30_000;
          return {
            data: { result: { recording: { ...detail, source: "upload" } } },
            headers: new Headers(),
          };
        },
      },
      sleep: async () => {},
      log: () => {},
      transcripts: {} as never,
      now: () => clock,
    },
    events,
    { enabledEntities: ["recordings"] },
  );
  assert.deepEqual(
    outcomes.map((o: any) => o.outcome),
    ["records", "records", "deferred"],
  );
});

void test("the cassettes hold no real key and walk the error paths", () => {
  const all = fs
    .readdirSync(CASSETTE_DIR)
    .map(f => fs.readFileSync(path.join(CASSETTE_DIR, f), "utf8"))
    .join("\n");
  assert.match(all, /rec_gone\?returnAiFields=true","status":404/);
  assert.match(all, /rec_0005\/fr\.json\?sig=fixture5","status":403/);
  assert.match(all, /rec_0008\/transcript\?format=json&lang=de","status":404/);
  assert.doesNotMatch(all, /@(?!example\.test)[a-z0-9-]+\.[a-z]/i);
});

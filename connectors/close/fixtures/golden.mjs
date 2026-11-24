/**
 * Golden files: what the folder produces from the replay cassettes. The
 * in-process connector this folder was ported from is gone, so these files
 * hold the output it was checked against. The API test
 * `api/src/connectors/close-folder.test.ts` compares byte for byte.
 *
 * Under `golden/`:
 * - `<entity>.json`: every row of the engine's default read (10 pages a
 *   chunk). `activities:Call` is `activities_Call.json`.
 * - `since/<entity>.json`: the incremental read from SINCE, for the 5 Search
 *   entities.
 * - `chunked/<entity>.json`: one page per chunk: row count, a checksum of
 *   the rows and every chunk's position, `hasMore` and record count.
 * - `webhooks.json`: the subscribed events and the outcome of each of the
 *   86 fixture events (`webhook-events.mjs`).
 *
 * Rewrite after an intended change:
 *
 *   node connectors/close/fixtures/golden.mjs --write
 *
 * Rebuild the cassettes from the emulator over `dataset.mjs` (the folder's
 * own requests, nothing from the Close API):
 *
 *   node connectors/close/fixtures/golden.mjs --record
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCENARIOS,
  SINCE,
  canonicalJson,
  ensureFolderInstalled,
  freezeClock,
  readFolder,
  runFolderCommand,
  runFolderWebhook,
  saveCassettes,
  startRecordingServer,
  startReplayServer,
} from "./harness.mjs";
import { buildWebhookEvents } from "./webhook-events.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = path.join(here, "golden");

/** The Search entities the incremental golden covers. */
export const SINCE_ENTITIES = [
  "leads",
  "contacts",
  "opportunities",
  "activities:Call",
  "activities:Email",
];

/** The golden file name of one entity. */
export const goldenFile = entity =>
  `${entity.replace(/[^a-zA-Z0-9_]/g, "_")}.json`;

/** A Basic-auth user name cannot hold ":", and `activities:Call` does. */
const tag = entity => entity.replace(/[^a-zA-Z0-9_]/g, "-");

/** The golden file text of one entity's rows: sorted keys, 2-space indent. */
export const goldenText = rows =>
  `${JSON.stringify(JSON.parse(canonicalJson(rows)), null, 2)}\n`;

const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");

/** Run `jobs` four at a time, keeping their order in the result. */
async function pool(jobs, concurrency = 4) {
  const results = new Array(jobs.length);
  let next = 0;
  await Promise.all(
    Array.from({ length: Math.min(concurrency, jobs.length) }, async () => {
      while (next < jobs.length) {
        const i = next++;
        results[i] = await jobs[i]();
      }
    }),
  );
  return results;
}

/**
 * Read everything through the folder on the cassettes:
 * { "<relative path>": text }. Throws on a cassette miss.
 */
export async function buildGolden() {
  ensureFolderInstalled();
  const server = await startReplayServer();
  try {
    const discover = await runFolderCommand("discover", {
      config: { api_key: "api_test_golden_discover", __base_url: server.url },
    });
    const entities = (
      discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? []
    ).map(s => s.name);
    if (entities.length === 0) throw new Error("discover found no entities");
    const read = (scenario, entity, options) =>
      readFolder({
        entity,
        config: {
          api_key: `api_test_golden_${scenario}_${tag(entity)}`,
          __base_url: server.url,
        },
        ...options,
      });
    // Each read has its own API key, so the server logs its requests apart.
    const entityFiles = await pool(
      entities.map(entity => async () => {
        const { rows } = await read("default", entity, { maxIterations: 10 });
        const chunked = await read("chunked", entity, { maxIterations: 1 });
        return [
          [goldenFile(entity), goldenText(rows)],
          [
            `chunked/${goldenFile(entity)}`,
            goldenText({
              rowCount: chunked.rows.length,
              rowsSha256: sha256(canonicalJson(chunked.rows)),
              chunks: chunked.chunks,
            }),
          ],
        ];
      }),
    );
    const sinceFiles = await pool(
      SINCE_ENTITIES.map(entity => async () => {
        const { rows } = await read("since", entity, {
          maxIterations: 10,
          since: SINCE,
        });
        return [[`since/${goldenFile(entity)}`, goldenText(rows)]];
      }),
    );
    const out = Object.fromEntries([...entityFiles, ...sinceFiles].flat());
    const subscribed = (await runFolderWebhook({})).events;
    const webhook = await runFolderWebhook({
      events: buildWebhookEvents(subscribed),
    });
    out["webhooks.json"] = goldenText({
      events: webhook.events,
      outcomes: webhook.outcomes,
    });
    if (server.misses.length > 0) {
      throw new Error(`cassette misses: ${server.misses.join(", ")}`);
    }
    return out;
  } finally {
    await server.close();
  }
}

/**
 * Rebuild `cassettes/` from the Close emulator: the folder reads every
 * entity in every scenario, runs `discover` and `check`, and what it asked
 * and was answered is kept. Nothing calls Close.
 */
export async function recordCassettes() {
  const { ORG, buildDataset } = await import("./dataset.mjs");
  const { CLOSE_MEMBERSHIP_FIELDS } = await import("../memberships.ts");
  ensureFolderInstalled();
  const restoreClock = freezeClock();
  const server = await startRecordingServer(buildDataset());
  const byFile = new Map();
  const keep = (file, apiKey) => {
    if (!byFile.has(file)) byFile.set(file, new Map());
    for (const key of server.requests(apiKey)) {
      byFile.get(file).set(key, server.recorded.get(key));
    }
  };
  try {
    const schemaKey = "api_test_record_discover";
    const discover = await runFolderCommand("discover", {
      config: { api_key: schemaKey, __base_url: server.url },
    });
    const entities = (
      discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? []
    ).map(s => s.name);
    if (entities.length === 0) throw new Error("discover found no entities");
    keep("discover", schemaKey);
    for (const entity of entities) {
      for (const scenario of SCENARIOS) {
        const apiKey = `api_test_record_${scenario.name}_${tag(entity)}`;
        await readFolder({
          entity,
          config: {
            api_key: apiKey,
            __base_url: server.url,
            ...(scenario.pageSize ? { __page_size: scenario.pageSize } : {}),
          },
          since: scenario.since,
          maxIterations: scenario.maxIterations,
        });
        keep(entity, apiKey);
      }
    }
    const checkKey = "api_test_record_check";
    const check = await runFolderCommand("check", {
      config: { api_key: checkKey, __base_url: server.url },
    });
    const status = check.messages.find(m => m.type === "CONNECTION_STATUS")
      ?.connectionStatus?.status;
    if (status !== "SUCCEEDED") throw new Error("check failed while recording");
    keep("me", checkKey);
    // What only the folder asks for (`FOLDER_ONLY`), read by the sync only
    // when a connection has no webhooks: recorded by hand, from the same
    // emulator.
    const folderOnlyKey = "api_test_record_folder_only";
    const auth = `Basic ${Buffer.from(`${folderOnlyKey}:`).toString("base64")}`;
    for (const route of [
      "/me/",
      `/organization/${ORG}/?_fields=${CLOSE_MEMBERSHIP_FIELDS}`,
      "/custom_field/activity/",
      "/custom_field/custom_object_type/",
    ]) {
      const response = await fetch(`${server.url}${route}`, {
        headers: { authorization: auth },
      });
      if (!response.ok) throw new Error(`${route}: ${response.status}`);
    }
    keep("folder_only", folderOnlyKey);
  } finally {
    await server.close();
    restoreClock();
  }
  saveCassettes(byFile);
  const total = [...byFile.values()].reduce((sum, map) => sum + map.size, 0);
  console.log(
    `recorded ${total} interactions in ${byFile.size} cassette files`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--record")) {
    await recordCassettes();
  } else {
    const golden = await buildGolden();
    if (process.argv.includes("--write")) {
      fs.rmSync(GOLDEN_DIR, { recursive: true, force: true });
      for (const [file, text] of Object.entries(golden)) {
        const target = path.join(GOLDEN_DIR, file);
        fs.mkdirSync(path.dirname(target), { recursive: true });
        fs.writeFileSync(target, text);
      }
      console.log(`wrote ${Object.keys(golden).length} golden files`);
    } else {
      for (const [file, text] of Object.entries(golden)) {
        console.log(`${file}: ${text.length} bytes`);
      }
    }
  }
}

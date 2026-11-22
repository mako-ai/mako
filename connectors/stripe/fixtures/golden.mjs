/**
 * Golden files: what the folder produces from the replay cassettes. The
 * in-process connector this folder was ported from is gone, so these files
 * hold the output it was checked against. The API test
 * `api/src/connectors/stripe-folder.test.ts` compares byte for byte.
 *
 * Under `golden/`, one file per scenario (harness `SCENARIOS`) and entity:
 * - `default/<entity>.json` and `since/<entity>.json`: the requests sent and
 *   every row read;
 * - `chunked/<entity>.json` and `small-pages/<entity>.json`: the requests
 *   sent, the row count, a checksum of the rows and every chunk's cursor and
 *   `hasMore`.
 * - `webhooks.json`: the subscribed events and the folder's outcome for one
 *   event of each type, built from whole list rows (`webhook-events.mjs`).
 *
 * Rewrite after an intended change:
 *
 *   node connectors/stripe/fixtures/golden.mjs --write
 *
 * Rebuild the cassettes from the emulator over `dataset.mjs` (the folder's
 * own requests, nothing from Stripe):
 *
 *   node connectors/stripe/fixtures/golden.mjs --record
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  SCENARIOS,
  canonicalJson,
  ensureFolderInstalled,
  readFolder,
  runFolderCommand,
  saveCassettes,
  startRecordingServer,
  startReplayServer,
} from "./harness.mjs";
import { buildWebhookEvents, wholeRows } from "./webhook-events.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = path.join(here, "golden");

/** Scenarios whose golden file holds a checksum, not the rows. */
export const CHECKSUM_SCENARIOS = ["chunked", "small-pages"];

/** The golden file of one scenario and entity, relative to GOLDEN_DIR. */
export const goldenFile = (scenario, entity) => `${scenario}/${entity}.json`;

/** The golden file text: sorted keys, 2-space indent. */
export const goldenText = value =>
  `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;

/** SHA-256 of the rows as canonical JSON. */
export const rowsSha256 = rows =>
  crypto.createHash("sha256").update(canonicalJson(rows)).digest("hex");

/** The folder's entities, in catalog order. */
async function folderEntities() {
  const discover = await runFolderCommand("discover", {
    config: { api_key: "sk_test_schema" },
  });
  const entities = (
    discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? []
  ).map(s => s.name);
  if (entities.length === 0) throw new Error("discover found no entities");
  return entities;
}

/** One read of `entity` in `scenario`, under `apiKey`. */
const readScenario = (server, scenario, entity, apiKey) =>
  readFolder({
    entity,
    config: {
      api_key: apiKey,
      api_base_url: server.url,
      ...(scenario.pageSize ? { __page_size: scenario.pageSize } : {}),
    },
    since: scenario.since,
    maxIterations: scenario.maxIterations,
  });

/**
 * Read everything through the folder on the cassettes:
 * { "<relative path>": text }. Throws on a cassette miss.
 */
export async function buildGolden() {
  ensureFolderInstalled();
  const entities = await folderEntities();
  const server = await startReplayServer();
  try {
    const out = {};
    for (const scenario of SCENARIOS) {
      for (const entity of entities) {
        const apiKey = `sk_test_golden_${scenario.name}_${entity}`;
        const { rows, chunks } = await readScenario(
          server,
          scenario,
          entity,
          apiKey,
        );
        const requests = server.requests(apiKey);
        out[goldenFile(scenario.name, entity)] = goldenText(
          CHECKSUM_SCENARIOS.includes(scenario.name)
            ? {
                chunks,
                requests,
                rowCount: rows.length,
                rowsSha256: rowsSha256(rows),
              }
            : { requests, rows },
        );
      }
    }
    const spec = (await runFolderCommand("spec")).messages.find(
      m => m.type === "SPEC",
    )?.spec;
    const events = spec?.mako?.webhooks?.events ?? [];
    if (events.length === 0) throw new Error("spec subscribes to no events");
    const apiKey = "sk_test_golden_webhooks";
    const webhook = await runFolderCommand("webhook", {
      config: { api_key: apiKey, api_base_url: server.url },
      batch: { events: buildWebhookEvents(events, wholeRows()) },
    });
    if (webhook.code !== 0) {
      throw new Error(`webhook failed: ${webhook.stderr}`);
    }
    out["webhooks.json"] = goldenText({
      events,
      outcomes: webhook.messages
        .filter(m => m.type === "WEBHOOK")
        .map(m => m.webhook),
      requests: server.requests(apiKey),
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
 * Rebuild `cassettes/` from the Stripe emulator: the folder reads every
 * entity in every scenario and runs `check`, and what it asked and was
 * answered is kept. Nothing calls Stripe.
 */
export async function recordCassettes() {
  const { buildDataset } = await import("./dataset.mjs");
  ensureFolderInstalled();
  const entities = await folderEntities();
  const server = await startRecordingServer(buildDataset());
  const byFile = new Map();
  const keep = (file, apiKey) => {
    if (!byFile.has(file)) byFile.set(file, new Map());
    for (const key of server.requestKeys(apiKey)) {
      byFile.get(file).set(key, server.recorded.get(key));
    }
  };
  try {
    for (const entity of entities) {
      for (const scenario of SCENARIOS) {
        const apiKey = `sk_test_record_${scenario.name}_${entity}`;
        await readScenario(server, scenario, entity, apiKey);
        keep(entity, apiKey);
      }
    }
    const checkKey = "sk_test_record_check";
    const check = await runFolderCommand("check", {
      config: { api_key: checkKey, api_base_url: server.url },
    });
    const status = check.messages.find(m => m.type === "CONNECTION_STATUS")
      ?.connectionStatus?.status;
    if (status !== "SUCCEEDED") throw new Error("check failed while recording");
    keep("account", checkKey);
  } finally {
    await server.close();
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

/**
 * Golden files: what the folder produces from the replay cassettes. The
 * in-process connector this folder was ported from is gone, so these files
 * hold the output it was checked against. The API test
 * `api/src/connectors/claap-folder.test.ts` compares byte for byte.
 *
 * Under `golden/`:
 * - `default/<entity>.json`: every row of the engine's default read (10
 *   pages a chunk).
 * - `since/<entity>.json`: the incremental read from SINCE, 5 rows a page.
 * - `lookback/<entity>.json`: the same read with `recordings_lookback_days: 3`,
 *   which reads 1 more recording than `since` alone.
 * - `chunked/<entity>.json`: one page per chunk: row count, a checksum of
 *   the rows and every chunk's position and `hasMore`.
 * - `webhooks.json`: the outcome of each of the 10 fixture deliveries in a
 *   box batch, with transcripts on and with transcripts off.
 *
 * Download times (`fetchedAt`) are masked as `<fetchedAt>`, and a time that
 * is the wall clock of the run as `<now>`.
 *
 * Rewrite after an intended change:
 *
 *   node connectors/claap/fixtures/golden.mjs --write
 *
 * Rebuild the cassettes from the emulator over `dataset.mjs` (the folder's
 * own requests, nothing from the Claap API):
 *
 *   node connectors/claap/fixtures/golden.mjs --record
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENTITIES,
  QUOTA_SCENARIO,
  RATE_LIMIT_ENTITIES,
  RATE_LIMIT_SCENARIO,
  SCENARIOS,
  canonicalJson,
  ensureFolderInstalled,
  freezeClock,
  masked,
  readFolder,
  runFolderCommand,
  saveCassettes,
  startRecordingServer,
  startReplayServer,
} from "./harness.mjs";
import { buildWebhookDeliveries } from "./webhook-events.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = path.join(here, "golden");

/** The scenarios with a golden directory. */
export const GOLDEN_SCENARIOS = ["default", "since", "lookback", "chunked"];

const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");

/** The golden file text of a value: sorted keys, 2-space indent. */
export const goldenText = value =>
  `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;

/**
 * A value with every download time masked, at any depth, and every time that
 * fell back to the wall clock (a transcript's `sourceTs`) as `<now>`.
 * `new Date()` is not frozen by `freezeClock`, so it is the real time.
 */
export const withoutClock = value => {
  const now = new Date().getTime();
  const download = JSON.parse(JSON.stringify(value), (_key, v) =>
    v && typeof v === "object" && !Array.isArray(v) ? masked(v) : v,
  );
  return JSON.parse(
    JSON.stringify(download).replace(
      /\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z/g,
      iso => (Math.abs(Date.parse(iso) - now) < 60_000 ? "<now>" : iso),
    ),
  );
};

/** The folder's config for one run; the key keeps each run's request log apart. */
function configFor(scenario, entity, baseUrl) {
  return {
    api_key: `api_test_golden_${scenario.name}_${entity}`,
    api_base_url: baseUrl,
    ...(scenario.config ?? {}),
    ...(scenario.pageSize ? { __page_size: scenario.pageSize } : {}),
  };
}

/** Run one box batch of the fixture deliveries. */
async function webhookOutcomes(server, transcripts) {
  const deliveries = buildWebhookDeliveries();
  const run = await runFolderCommand("webhook", {
    config: {
      api_key: `api_test_golden_webhooks_${transcripts}`,
      api_base_url: server.url,
    },
    batch: {
      events: deliveries.map(d => d.event),
      enabledEntities: transcripts
        ? ENTITIES
        : ENTITIES.filter(e => e !== "recording_transcripts"),
    },
  });
  if (run.code !== 0) throw new Error(`webhook batch failed: ${run.stderr}`);
  return run.messages
    .filter(m => m.type === "WEBHOOK")
    .map((m, i) => ({ delivery: deliveries[i].name, ...m.webhook }));
}

/**
 * Read everything through the folder on the cassettes:
 * { "<relative path>": text }. Throws on a cassette miss.
 */
export async function buildGolden() {
  ensureFolderInstalled();
  const restoreClock = freezeClock();
  const server = await startReplayServer();
  try {
    const out = {};
    for (const name of GOLDEN_SCENARIOS) {
      const scenario = SCENARIOS.find(s => s.name === name);
      for (const entity of ENTITIES) {
        const { rows, chunks } = await readFolder({
          entity,
          config: configFor(scenario, entity, server.url),
          since: scenario.since,
          maxIterations: scenario.maxIterations,
        });
        out[`${name}/${entity}.json`] =
          name === "chunked"
            ? goldenText({
                rowCount: rows.length,
                rowsSha256: sha256(canonicalJson(withoutClock(rows))),
                chunks,
              })
            : goldenText(withoutClock(rows));
      }
    }
    out["webhooks.json"] = goldenText(
      withoutClock({
        transcripts: await webhookOutcomes(server, true),
        transcriptsOff: await webhookOutcomes(server, false),
      }),
    );
    if (server.misses.length > 0) {
      throw new Error(`cassette misses: ${server.misses.join(", ")}`);
    }
    return out;
  } finally {
    await server.close();
    restoreClock();
  }
}

/**
 * Rebuild `cassettes/` from the Claap emulator: the folder reads every
 * entity in every scenario (rate-limited and quota runs included), runs
 * `check` and the fixture webhook batch, and what it asked and was answered
 * is kept. Nothing calls Claap. `dir` defaults to `cassettes/`.
 */
export async function recordCassettes(dir) {
  ensureFolderInstalled();
  const restoreClock = freezeClock();
  const server = await startRecordingServer();
  try {
    const scenarios = [...SCENARIOS, RATE_LIMIT_SCENARIO, QUOTA_SCENARIO];
    for (const scenario of scenarios) {
      for (const entity of ENTITIES) {
        if (scenario.rateLimited && !RATE_LIMIT_ENTITIES.includes(entity)) {
          continue;
        }
        const tag = scenario.quota
          ? "_quota"
          : scenario.rateLimited
            ? "_ratelimit"
            : "";
        await readFolder({
          entity,
          config: {
            api_key: `api_test_record${tag}_${scenario.name}_${entity}`,
            api_base_url: server.url,
            ...(scenario.config ?? {}),
            ...(scenario.pageSize ? { __page_size: scenario.pageSize } : {}),
          },
          since: scenario.since,
          maxIterations: scenario.maxIterations,
        }).catch(() => {});
      }
    }
    const check = await runFolderCommand("check", {
      config: { api_key: "api_test_record_check", api_base_url: server.url },
    });
    const status = check.messages.find(m => m.type === "CONNECTION_STATUS")
      ?.connectionStatus?.status;
    if (status !== "SUCCEEDED") throw new Error("check failed while recording");
    await runFolderCommand("check", {
      config: {
        api_key: "api_test_record_revoked_check",
        api_base_url: server.url,
      },
    });
    await webhookOutcomes(server, true);
    saveCassettes(server.recorded, dir);
    console.log(`recorded ${server.recorded.size} interactions`);
  } finally {
    await server.close();
    restoreClock();
  }
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

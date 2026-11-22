/**
 * Golden files: what the folder produces from the replay cassettes. The
 * in-process connector this folder was ported from is gone, so these files
 * hold the output it was checked against. The API test
 * `api/src/connectors/calendly-folder.test.ts` compares byte for byte.
 *
 * Under `golden/`, per entity (7):
 * - `default/<entity>.json`: every row of the engine's default read (10
 *   pages a chunk) and the number of requests it took;
 * - `since/<entity>.json`: the incremental read from SINCE, same shape;
 * - `chunked/<entity>.json`: one page per chunk: row count, a checksum of
 *   the rows, the request count and every chunk's position and `hasMore`;
 * - `small-pages/<entity>.json`: two rows a page, one page per chunk, same
 *   shape as `chunked`;
 * - `rate-limited/<entity>.json`: every request answered 429 once and
 *   retried, for `users`, `scheduled_events` and `invitees`: row count,
 *   checksum and request count.
 * And `webhooks.json`: the subscribed events, the events per entity
 * selection and the outcome of each fixture event (`webhook-events.mjs`).
 *
 * Rewrite after an intended change:
 *
 *   node connectors/calendly/fixtures/golden.mjs --write
 *
 * Rebuild the cassettes from the emulator over `dataset.mjs` (the folder's
 * own requests, nothing from Calendly):
 *
 *   node connectors/calendly/fixtures/golden.mjs --record
 */
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  RATE_LIMIT_ENTITIES,
  RATE_LIMIT_SCENARIO,
  SCENARIOS,
  canonicalJson,
  ensureFolderInstalled,
  readFolder,
  runFolderCommand,
  runFolderWebhookMapping,
  saveCassettes,
  scenarioConfig,
  startRecordingServer,
  startReplayServer,
  tokenFor,
} from "./harness.mjs";
import { BASE } from "./dataset.mjs";
import { buildWebhookEvents } from "./webhook-events.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = path.join(here, "golden");

/** The entity selections whose webhook events the golden file holds. */
export const WEBHOOK_SELECTIONS = [
  [],
  ["invitees"],
  ["scheduled_events"],
  ["event_types"],
  ["groups"],
  ["invitees", "event_types"],
];

/** The golden file text: sorted keys, 2-space indent. */
export const goldenText = value =>
  `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;

const sha256 = text => crypto.createHash("sha256").update(text).digest("hex");

const scenarioByName = name => SCENARIOS.find(s => s.name === name);

/**
 * A read with the server's own URL written back as `BASE`: Calendly's URIs
 * carry the port of the local server, which changes on every run.
 */
const portable = (value, server) =>
  JSON.parse(JSON.stringify(value).split(server.url).join(BASE));

/** What one scenario keeps of a read. */
function summarize(scenario, { rows, chunks }, requestCount) {
  if (scenario.name === "default" || scenario.name === "since") {
    return { requestCount, rows };
  }
  const summary = {
    requestCount,
    rowCount: rows.length,
    rowsSha256: sha256(canonicalJson(rows)),
  };
  return scenario.rateLimited ? summary : { ...summary, chunks };
}

/** Run `jobs` six at a time, keeping their order in the result. */
async function pool(jobs, concurrency = 6) {
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

/** The (scenario, entity) pairs the golden files cover, with the entities. */
async function entitiesOf(server) {
  const discover = await runFolderCommand("discover", {
    config: { access_token: "cal_test_golden_discover" },
  });
  const entities = (
    discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? []
  ).map(s => s.name);
  if (entities.length === 0) throw new Error("discover found no entities");
  const pairs = [];
  for (const scenario of [...SCENARIOS, RATE_LIMIT_SCENARIO]) {
    for (const entity of entities) {
      if (scenario.rateLimited && !RATE_LIMIT_ENTITIES.includes(entity)) {
        continue;
      }
      pairs.push({ scenario, entity });
    }
  }
  return { entities, pairs, server };
}

/**
 * Read everything through the folder on the cassettes:
 * { "<relative path>": text }. Throws on a cassette miss.
 */
export async function buildGolden() {
  ensureFolderInstalled();
  const server = await startReplayServer();
  try {
    const { pairs } = await entitiesOf(server);
    const reads = await pool(
      pairs.map(({ scenario, entity }) => async () => {
        const token = tokenFor("golden", scenario, entity);
        const run = await readFolder({
          entity,
          since: scenario.since,
          maxIterations: scenario.maxIterations,
          config: scenarioConfig(token, server, scenario),
        });
        return {
          scenario,
          entity,
          summary: summarize(
            scenario,
            portable(run, server),
            server.requests(token).length,
          ),
        };
      }),
    );
    const out = {};
    for (const { scenario, entity, summary } of reads) {
      out[`${scenario.name}/${entity}.json`] = goldenText(summary);
    }
    const webhook = await runFolderWebhookMapping({
      events: buildWebhookEvents(),
      selections: WEBHOOK_SELECTIONS,
    });
    out["webhooks.json"] = goldenText({
      events: webhook.events,
      eventsForEntities: webhook.eventsForEntities,
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
 * Rebuild `cassettes/` from the Calendly emulator: the folder reads every
 * entity in every scenario and runs `check`, and what it asked and was
 * answered is kept. Nothing calls Calendly.
 */
export async function recordCassettes() {
  const { buildDataset } = await import("./dataset.mjs");
  ensureFolderInstalled();
  const server = await startRecordingServer(buildDataset());
  const byFile = new Map();
  const keep = (file, token) => {
    if (!byFile.has(file)) byFile.set(file, new Map());
    for (const key of server.requests(token)) {
      byFile.get(file).set(key, server.recorded.get(key));
    }
  };
  try {
    const { pairs } = await entitiesOf(server);
    await pool(
      pairs.map(({ scenario, entity }) => async () => {
        const token = tokenFor("record", scenario, entity);
        await readFolder({
          entity,
          since: scenario.since,
          maxIterations: scenario.maxIterations,
          config: scenarioConfig(token, server, scenario),
        });
      }),
    );
    for (const { scenario, entity } of pairs) {
      keep(entity, tokenFor("record", scenario, entity));
    }
    const checkToken = "cal_test_record_check";
    const check = await runFolderCommand("check", {
      config: { access_token: checkToken, api_base_url: server.url },
    });
    const status = check.messages.find(
      m => m.type === "CONNECTION_STATUS",
    )?.connectionStatus;
    if (status?.status !== "SUCCEEDED") {
      throw new Error(`check failed while recording: ${status?.message}`);
    }
    keep("users_me", checkToken);
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

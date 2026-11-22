/**
 * Golden rows: what the folder reads from the cassettes, per scenario and
 * entity. The in-process connector this folder was ported from is gone, so
 * these files hold the output it was checked against. Each file holds the
 * rows, the position after every chunk and every request sent (query
 * string, body, the header that carried the credential and the content
 * type). Six scenarios:
 *
 * - chunked: one request per chunk, so every page, offset and cursor
 *   crosses a chunk boundary;
 * - small-pages: two rows a page (a probe's batch size), one page per chunk;
 * - default: the engine's default chunk of 10 requests;
 * - since: the incremental read, a client filter on `updated_at`;
 * - api-key: the credential in `X-API-Key` instead of a bearer token;
 * - settings-batch: the connection's `sync_batch_size`.
 *
 * The API test `api/src/connectors/workspace/rest-folder-golden.test.ts`
 * compares byte for byte. After an intended change:
 *
 *   node connectors/rest/fixtures/golden.mjs --record    # rebuild the cassettes
 *   node connectors/rest/fixtures/golden.mjs --write     # rewrite the golden files
 *
 * `--record` runs the folder through every scenario against a local emulator
 * of the dataset (`dataset.mjs`) and keeps each request it sent with the
 * answer. It never calls a real API. Run `--record` first, then `--write`.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CASSETTE_DIR,
  ENTITIES,
  SCENARIOS,
  canonicalJson,
  ensureFolderInstalled,
  readFolder,
  runFolderCommand,
  saveCassettes,
  scenarioConfig,
  startRecordingServer,
  startReplayServer,
  testConfig,
  tokenFor,
} from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = path.join(here, "golden");
export const GOLDEN_SCENARIOS = SCENARIOS.map(s => s.name);
export const ENTITY_NAMES = ENTITIES.map(e => e.name);

/** The golden file text: sorted keys, 2-space indent. */
export const goldenText = value =>
  `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;

export const goldenFile = (scenario, entity) =>
  path.join(GOLDEN_DIR, scenario, `${entity}.json`);

/** Read every scenario and entity on the cassettes: { "scenario/entity": text }. */
export async function buildGolden() {
  ensureFolderInstalled();
  const server = await startReplayServer();
  try {
    const out = {};
    for (const scenario of SCENARIOS) {
      for (const entity of ENTITY_NAMES) {
        const token = tokenFor("golden", scenario, entity);
        const { rows, chunks } = await readFolder({
          entity,
          since: scenario.since,
          maxIterations: scenario.maxIterations,
          config: scenarioConfig(token, server, scenario),
        });
        out[`${scenario.name}/${entity}`] = goldenText({
          chunks,
          requests: server.requests(token),
          rows,
        });
      }
    }
    if (server.misses.length > 0) {
      throw new Error(`cassette misses: ${server.misses.join(", ")}`);
    }
    return out;
  } finally {
    await server.close();
  }
}

/** Rebuild the cassettes from the emulator, through the folder. */
export async function record() {
  ensureFolderInstalled();
  const server = await startRecordingServer();
  const byFile = new Map();
  const keep = (file, token) => {
    if (!byFile.has(file)) byFile.set(file, new Map());
    for (const key of server.requestKeys(token)) {
      byFile.get(file).set(key, server.recorded.get(key));
    }
  };
  try {
    for (const entity of ENTITY_NAMES) {
      for (const scenario of SCENARIOS) {
        const token = tokenFor("record", scenario, entity);
        await readFolder({
          entity,
          since: scenario.since,
          maxIterations: scenario.maxIterations,
          config: scenarioConfig(token, server, scenario),
        });
        keep(entity, token);
      }
    }
    for (const variant of ["", "_redirect_ok"]) {
      const token = `rest_test_record_check${variant}`;
      const result = await runFolderCommand("check", {
        config: testConfig(token, server),
      });
      const status = result.messages.find(
        m => m.type === "CONNECTION_STATUS",
      )?.connectionStatus;
      if (status?.status !== "SUCCEEDED") {
        throw new Error(`check failed while recording: ${status?.message}`);
      }
      keep("check", token);
    }
  } finally {
    await server.close();
  }
  saveCassettes(byFile, CASSETTE_DIR);
  const total = [...byFile.values()].reduce((sum, map) => sum + map.size, 0);
  console.log(
    `recorded ${total} interactions in ${byFile.size} cassette files`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--record")) {
    await record();
  } else {
    const golden = await buildGolden();
    if (process.argv.includes("--write")) {
      for (const [key, text] of Object.entries(golden)) {
        const [scenario, entity] = key.split("/");
        fs.mkdirSync(path.join(GOLDEN_DIR, scenario), { recursive: true });
        fs.writeFileSync(goldenFile(scenario, entity), text);
      }
      console.log(`wrote ${Object.keys(golden).length} golden files`);
    } else {
      for (const [key, text] of Object.entries(golden)) {
        console.log(`${key}: ${JSON.parse(text).rows.length} rows`);
      }
    }
  }
}

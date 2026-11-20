/**
 * Golden rows: what the folder reads from the cassettes, per scenario and
 * query. The in-process connector this folder was ported from is gone, so
 * these files hold the output it was checked against. Three scenarios:
 *
 * - default: the engine's default chunk of 10 requests;
 * - since: the incremental read, a client filter on `updated_at`;
 * - chunked: one request per chunk, so every cursor and offset crosses a
 *   chunk boundary. The file also holds the position after each chunk;
 * - small-pages: two rows a page (a probe's batch size), one page per chunk;
 * - hasura-secret: the credential goes in `x-hasura-admin-secret`, not a
 *   bearer header. The file also holds the requests with the header style.
 *
 * The API test `api/src/connectors/workspace/graphql-folder-golden.test.ts`
 * compares byte for byte. After an intended change:
 *
 *   node connectors/graphql/fixtures/golden.mjs --record    # rebuild the cassettes
 *   node connectors/graphql/fixtures/golden.mjs --write     # rewrite the golden files
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
  FLOW_QUERIES,
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
export const GOLDEN_SCENARIOS = [
  "default",
  "since",
  "chunked",
  "small-pages",
  "hasura-secret",
];
export const ENTITIES = FLOW_QUERIES.map(query => query.name);

/** The golden file text: sorted keys, 2-space indent. */
export const goldenText = value =>
  `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;

export const goldenFile = (scenario, entity) =>
  path.join(GOLDEN_DIR, scenario, `${entity}.json`);

const scenarioByName = name => SCENARIOS.find(s => s.name === name);

/** Read every golden scenario and query on the cassettes: { "scenario/entity": text }. */
export async function buildGolden() {
  ensureFolderInstalled();
  const server = await startReplayServer();
  try {
    const out = {};
    for (const name of GOLDEN_SCENARIOS) {
      const scenario = scenarioByName(name);
      for (const entity of ENTITIES) {
        const token = tokenFor("golden", scenario, entity);
        const { rows, chunks } = await readFolder({
          entity,
          since: scenario.since,
          maxIterations: scenario.maxIterations,
          config: scenarioConfig(token, server, scenario),
        });
        // Chunked keeps the position after each chunk. Hasura keeps the
        // requests with the header style that carried the credential.
        out[`${name}/${entity}`] = goldenText(
          name === "chunked"
            ? { chunks, rows }
            : name === "hasura-secret"
              ? { requests: server.requests(token), rows }
              : { rows },
        );
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
    for (const entity of ENTITIES) {
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
    const checkToken = "gql_test_record_check";
    const { queries: _queries, ...connection } = testConfig(checkToken, server);
    const result = await runFolderCommand("check", { config: connection });
    const status = result.messages.find(
      m => m.type === "CONNECTION_STATUS",
    )?.connectionStatus;
    if (status?.status !== "SUCCEEDED") {
      throw new Error(`check failed while recording: ${status?.message}`);
    }
    keep("check", checkToken);
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

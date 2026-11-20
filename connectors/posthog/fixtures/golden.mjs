/**
 * Golden rows: what the folder reads from the replay cassettes, per entity,
 * in three scenarios: the engine's default (10 requests a chunk), an
 * incremental read (`since`), and one request per chunk. The in-process
 * connector this folder was ported from is gone, so these files hold the
 * output it was checked against. The API test
 * `api/src/connectors/posthog-folder.test.ts` compares byte for byte.
 *
 * Files in `golden/`, per entity:
 * - `<entity>.json`          the rows of the default read
 * - `<entity>.since.json`    the rows of a read since `SINCE`
 * - `<entity>.chunked.json`  the resume position after every one-request
 *                            chunk, and the row count. Its rows equal the
 *                            default read's (`buildGolden` fails if not).
 *
 * Rewrite after an intended change:
 *
 *   node connectors/posthog/fixtures/golden.mjs --write
 *
 * Rebuild the cassettes (the folder against a local PostHog emulator over
 * `dataset.mjs`; it never calls PostHog), then rewrite the golden files:
 *
 *   node connectors/posthog/fixtures/golden.mjs --record
 *   node connectors/posthog/fixtures/golden.mjs --write
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  CHECK_VARIANTS,
  NO_SURVEYS_PROJECT_ID,
  SCENARIOS,
  SINCE,
  canonicalJson,
  ensureFolderInstalled,
  readFolder,
  runFolderCommand,
  saveCassettes,
  startRecordingServer,
  startReplayServer,
  testConfig,
} from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = path.join(here, "golden");

/** The three read scenarios that have golden files. */
export const GOLDEN_SCENARIOS = [
  { name: "default", suffix: "", maxIterations: 10 },
  { name: "since", suffix: ".since", maxIterations: 10, since: SINCE },
  { name: "chunked", suffix: ".chunked", maxIterations: 1 },
];

/** The golden file name of one entity in one scenario. */
export const goldenFile = (entity, scenario) =>
  `${entity}${scenario.suffix}.json`;

/** The golden file text of one value: sorted keys, 2-space indent. */
export const goldenText = value =>
  `${JSON.stringify(JSON.parse(canonicalJson(value)), null, 2)}\n`;

/** A folder config for one run: the page size and a short retry delay. */
const readConfig = (apiKey, server, scenario = {}) => ({
  ...testConfig(apiKey, server, scenario),
  ...(scenario.pageSize ? { __page_size: scenario.pageSize } : {}),
  __rate_limit_delay_ms: 1,
});

/** The entities the folder declares, in its order. */
async function folderEntities(server) {
  const discover = await runFolderCommand("discover", {
    config: testConfig("phx_test_golden_discover", server),
  });
  const entities = (
    discover.messages.find(m => m.type === "CATALOG")?.catalog?.streams ?? []
  ).map(s => s.name);
  if (entities.length === 0) throw new Error("discover found no entities");
  return entities;
}

/**
 * Read every entity through the folder on the cassettes, in the three
 * scenarios: { "<entity>.json": text, "<entity>.since.json": text, ... }.
 */
export async function buildGolden() {
  ensureFolderInstalled();
  const server = await startReplayServer();
  try {
    const out = {};
    for (const entity of await folderEntities(server)) {
      let defaultRows;
      for (const scenario of GOLDEN_SCENARIOS) {
        const { rows, chunks } = await readFolder({
          entity,
          since: scenario.since,
          maxIterations: scenario.maxIterations,
          config: readConfig(
            `phx_test_golden_${scenario.name}_${entity}`,
            server,
          ),
        });
        if (scenario.name === "default") defaultRows = rows;
        if (
          scenario.name === "chunked" &&
          canonicalJson(rows) !== canonicalJson(defaultRows)
        ) {
          throw new Error(`${entity}: chunked rows differ from the default`);
        }
        out[goldenFile(entity, scenario)] =
          scenario.name === "chunked"
            ? goldenText({ chunks, rows: rows.length })
            : goldenText(rows);
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

/**
 * Rebuild `cassettes/`: serve `dataset.mjs` through a local PostHog
 * emulator, run the folder through every scenario and the check, and write
 * what it was sent and answered. Never calls PostHog.
 */
export async function record() {
  ensureFolderInstalled();
  const { buildDataset } = await import("./dataset.mjs");
  const server = await startRecordingServer(buildDataset());
  const byFile = new Map();
  const keep = (file, apiKey) => {
    if (!byFile.has(file)) byFile.set(file, new Map());
    for (const key of server.requestKeys(apiKey)) {
      byFile.get(file).set(key, server.recorded.get(key));
    }
  };
  try {
    for (const entity of await folderEntities(server)) {
      for (const scenario of SCENARIOS) {
        const apiKey = `phx_test_record_${scenario.name}_${entity}`;
        await readFolder({
          entity,
          since: scenario.since,
          maxIterations: scenario.maxIterations,
          config: readConfig(apiKey, server, scenario),
        });
        keep(entity, apiKey);
      }
    }
    for (const variant of CHECK_VARIANTS.filter(v => v !== "revoked")) {
      const apiKey = `phx_test_record_check_${variant}`;
      const project =
        variant === "nosurveys" ? { projectId: NO_SURVEYS_PROJECT_ID } : {};
      const run = await runFolderCommand("check", {
        config: testConfig(apiKey, server, project),
      });
      const status = run.messages.find(
        m => m.type === "CONNECTION_STATUS",
      )?.connectionStatus;
      if (status?.status !== "SUCCEEDED") {
        throw new Error(
          `check (${variant}) failed while recording: ${status?.message}`,
        );
      }
      keep("check", apiKey);
    }
  } finally {
    await server.close();
  }
  saveCassettes(byFile);
  const total = [...byFile.values()].reduce((sum, map) => sum + map.size, 0);
  console.info(
    `Recorded ${total} interactions in ${byFile.size} cassette files.`,
  );
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  if (process.argv.includes("--record")) {
    await record();
  } else {
    const golden = await buildGolden();
    if (process.argv.includes("--write")) {
      fs.mkdirSync(GOLDEN_DIR, { recursive: true });
      for (const file of fs.readdirSync(GOLDEN_DIR)) {
        fs.rmSync(path.join(GOLDEN_DIR, file));
      }
      for (const [file, text] of Object.entries(golden)) {
        fs.writeFileSync(path.join(GOLDEN_DIR, file), text);
      }
      console.log(`wrote ${Object.keys(golden).length} golden files`);
    } else {
      for (const [file, text] of Object.entries(golden)) {
        const data = JSON.parse(text);
        const count = Array.isArray(data) ? data.length : data.rows;
        console.log(`${file}: ${count} rows`);
      }
    }
  }
}

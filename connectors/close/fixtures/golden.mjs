/**
 * Golden rows: what the folder reads from the replay cassettes, per entity,
 * in the engine's default scenario (10 pages a chunk). The in-process
 * connector this folder was ported from is gone, so these files hold the
 * output it was checked against. The API test
 * `api/src/connectors/close-folder.test.ts` compares byte for byte.
 *
 * One file per entity, named after the entity with `:` as `_`
 * (`activities:Call` is `activities_Call.json`).
 *
 * Rewrite after an intended change:
 *
 *   node connectors/close/fixtures/golden.mjs --write
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  canonicalJson,
  ensureFolderInstalled,
  readFolder,
  runFolderCommand,
  startReplayServer,
} from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = path.join(here, "golden");

/** The golden file name of one entity. */
export const goldenFile = entity =>
  `${entity.replace(/[^a-zA-Z0-9_]/g, "_")}.json`;

/** The golden file text of one entity's rows: sorted keys, 2-space indent. */
export const goldenText = rows =>
  `${JSON.stringify(JSON.parse(canonicalJson(rows)), null, 2)}\n`;

/** Read every entity through the folder on the cassettes: { entity: text }. */
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
    const out = {};
    for (const entity of entities) {
      const { rows } = await readFolder({
        entity,
        config: {
          api_key: `api_test_golden_${entity.replace(/[^a-zA-Z0-9_]/g, "-")}`,
          __base_url: server.url,
        },
        maxIterations: 10,
      });
      out[entity] = goldenText(rows);
    }
    if (server.misses.length > 0) {
      throw new Error(`cassette misses: ${server.misses.join(", ")}`);
    }
    return out;
  } finally {
    await server.close();
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const golden = await buildGolden();
  if (process.argv.includes("--write")) {
    fs.mkdirSync(GOLDEN_DIR, { recursive: true });
    for (const file of fs.readdirSync(GOLDEN_DIR)) {
      fs.rmSync(path.join(GOLDEN_DIR, file));
    }
    for (const [entity, text] of Object.entries(golden)) {
      fs.writeFileSync(path.join(GOLDEN_DIR, goldenFile(entity)), text);
    }
    console.log(`wrote ${Object.keys(golden).length} golden files`);
  } else {
    for (const [entity, text] of Object.entries(golden)) {
      console.log(`${entity}: ${JSON.parse(text).length} rows`);
    }
  }
}

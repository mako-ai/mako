/**
 * Golden rows: what the folder reads from the replay cassettes, per entity,
 * in the engine's default scenario (100 rows a page, 10 pages a chunk).
 * The in-process connector this folder was ported from is gone, so these
 * files hold the output it was checked against. The API test
 * `api/src/connectors/workspace/pandadoc-folder-golden.test.ts` compares
 * byte for byte.
 *
 * Rewrite after an intended change:
 *
 *   node connectors/pandadoc/fixtures/golden.mjs --write
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import {
  ENTITIES,
  canonicalJson,
  ensureFolderInstalled,
  readFolder,
  startReplayServer,
} from "./harness.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));
export const GOLDEN_DIR = path.join(here, "golden");

/** The golden file text of one entity's rows: sorted keys, 2-space indent. */
export const goldenText = rows =>
  `${JSON.stringify(JSON.parse(canonicalJson(rows)), null, 2)}\n`;

/** Read every entity through the folder on the cassettes: { entity: text }. */
export async function buildGolden() {
  ensureFolderInstalled();
  const server = await startReplayServer();
  try {
    const out = {};
    for (const entity of ENTITIES) {
      const { rows } = await readFolder({
        entity,
        config: {
          api_key: `api_test_golden_${entity}`,
          api_base_url: server.url,
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
    for (const [entity, text] of Object.entries(golden)) {
      fs.writeFileSync(path.join(GOLDEN_DIR, `${entity}.json`), text);
    }
    console.log(`wrote ${Object.keys(golden).length} golden files`);
  } else {
    for (const [entity, text] of Object.entries(golden)) {
      console.log(`${entity}: ${JSON.parse(text).length} rows`);
    }
  }
}

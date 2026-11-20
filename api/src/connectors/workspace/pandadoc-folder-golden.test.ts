/**
 * The PandaDoc folder's rows on the replay cassettes, per entity, against the
 * golden files in connectors/pandadoc/fixtures/golden/. The in-process
 * connector the folder was checked against is gone, so these files are the
 * record of what it produced. Rewrite them, after an intended change, with
 * `node connectors/pandadoc/fixtures/golden.mjs --write`.
 *
 * Run: node --import tsx --test src/connectors/workspace/pandadoc-folder-golden.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import path from "node:path";
import { test } from "node:test";

void test("the folder reads the cassettes into the golden rows, byte for byte", async () => {
  const { GOLDEN_DIR, buildGolden } =
    await import("../../../../connectors/pandadoc/fixtures/golden.mjs");
  const { ENTITIES } =
    await import("../../../../connectors/pandadoc/fixtures/harness.mjs");
  const actual = await buildGolden();
  assert.deepEqual(Object.keys(actual).sort(), [...ENTITIES].sort());
  for (const entity of ENTITIES) {
    const expected = fs.readFileSync(
      path.join(GOLDEN_DIR, `${entity}.json`),
      "utf8",
    );
    assert.ok(JSON.parse(expected).length > 0, `${entity} golden is empty`);
    assert.equal(
      actual[entity],
      expected,
      `${entity} differs from fixtures/golden/${entity}.json`,
    );
  }
});

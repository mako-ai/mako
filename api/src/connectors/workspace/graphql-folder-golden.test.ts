/**
 * The GraphQL folder's rows on the replay cassettes, per scenario (default,
 * since, chunked) and query, against the golden files. The in-process
 * connector the folder was checked against is gone, so these files are the
 * record of what it produced. Rewrite them, after an intended change, with
 * `node connectors/graphql/fixtures/golden.mjs --write`.
 *
 * Run: node --import tsx --test src/connectors/workspace/graphql-folder-golden.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

void test("the folder reads the cassettes into the golden rows, byte for byte", async () => {
  const { ENTITIES, GOLDEN_SCENARIOS, buildGolden, goldenFile } =
    await import("../../../../connectors/graphql/fixtures/golden.mjs");
  const actual = await buildGolden();
  const expectedKeys = GOLDEN_SCENARIOS.flatMap(scenario =>
    ENTITIES.map(entity => `${scenario}/${entity}`),
  );
  assert.equal(expectedKeys.length, 15);
  assert.deepEqual(Object.keys(actual).sort(), expectedKeys.sort());
  for (const key of expectedKeys) {
    const [scenario, entity] = key.split("/");
    const expected = fs.readFileSync(goldenFile(scenario, entity), "utf8");
    assert.equal(actual[key], expected, key);
  }
});

void test("the golden rows cover a default, an incremental and a chunked read", async () => {
  const { ENTITIES, goldenFile } =
    await import("../../../../connectors/graphql/fixtures/golden.mjs");
  const read = (scenario: string, entity: string) =>
    JSON.parse(fs.readFileSync(goldenFile(scenario, entity), "utf8"));
  // A cursor and an offset query read in full; the chunked read holds the
  // same rows as the default one, cut at every request.
  assert.equal(read("default", "online_listings").rows.length, 70);
  assert.equal(read("default", "items").rows.length, 35);
  for (const entity of ENTITIES) {
    assert.deepEqual(
      read("chunked", entity).rows,
      read("default", entity).rows,
      entity,
    );
  }
  // One request per chunk: the 70 listings cross 4 chunk boundaries' worth
  // of cursor and offset state.
  assert.equal(read("chunked", "online_listings").chunks.length, 4);
  // `since` keeps rows whose `updated_at` is after it and drops rows without.
  assert.equal(read("since", "items").rows.length, 20);
  assert.equal(read("since", "online_listings").rows.length, 25);
  assert.equal(read("since", "enquiries").rows.length, 0);
});

/**
 * The REST folder's rows, chunk positions and requests on the replay
 * cassettes, per scenario and entity, against the golden files. The
 * in-process connector the folder was checked against is gone, so these
 * files are the record of what it produced. Rewrite them, after an intended
 * change, with `node connectors/rest/fixtures/golden.mjs --write`.
 *
 * Run: node --import tsx --test src/connectors/workspace/rest-folder-golden.test.ts
 */
import assert from "node:assert/strict";
import fs from "node:fs";
import { test } from "node:test";

void test("the folder reads the cassettes into the golden files, byte for byte", async () => {
  const { ENTITY_NAMES, GOLDEN_SCENARIOS, buildGolden, goldenFile } =
    await import("../../../../connectors/rest/fixtures/golden.mjs");
  const actual = await buildGolden();
  const expectedKeys = GOLDEN_SCENARIOS.flatMap(scenario =>
    ENTITY_NAMES.map(entity => `${scenario}/${entity}`),
  );
  assert.equal(expectedKeys.length, 42);
  assert.deepEqual(Object.keys(actual).sort(), expectedKeys.sort());
  for (const key of expectedKeys) {
    const [scenario, entity] = key.split("/");
    const expected = fs.readFileSync(goldenFile(scenario, entity), "utf8");
    assert.equal(actual[key], expected, key);
  }
});

void test("the golden files cover paging, incremental reads, both header styles and the batch size", async () => {
  const { goldenFile } =
    await import("../../../../connectors/rest/fixtures/golden.mjs");
  const read = (scenario: string, entity: string) =>
    JSON.parse(fs.readFileSync(goldenFile(scenario, entity), "utf8"));
  // Page, offset and cursor pagination cross chunk boundaries.
  assert.equal(read("default", "listings").rows.length, 70);
  assert.equal(read("chunked", "listings").chunks.length, 3);
  assert.equal(read("chunked", "events").chunks.length, 4);
  assert.equal(read("chunked", "orders").chunks.length, 4);
  assert.equal(read("small-pages", "events").chunks.length, 12);
  // `since` narrows on updated_at; rows without it are dropped.
  assert.equal(read("since", "orders").rows.length, 20);
  assert.equal(read("since", "listings").rows.length, 25);
  assert.equal(read("since", "search").rows.length, 15);
  // The connection's batch size applies to an entity with none of its own.
  assert.equal(read("settings-batch", "plain").requests.length, 4);
  assert.equal(read("default", "plain").requests.length, 1);
  // A 2-row page is not what this server answers: the read stops after one.
  assert.equal(read("small-pages", "wrapped").rows.length, 6);
  // The credential travels in the header each scenario names.
  for (const [scenario, style] of [
    ["default", "bearer"],
    ["api-key", "api-key"],
  ]) {
    const { requests } = read(scenario, "listings");
    assert.ok(requests.length > 0, scenario);
    assert.ok(
      requests.every((r: string) => r.includes(`(${style}; `)),
      scenario,
    );
  }
  // The POST search sends its body as JSON.
  assert.ok(
    read("default", "search").requests.every(
      (r: string) => r.startsWith("POST ") && r.endsWith("; application/json)"),
    ),
  );
});

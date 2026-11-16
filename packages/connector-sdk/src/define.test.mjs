import { test } from "node:test";
import assert from "node:assert/strict";
import { defineConnector } from "./define.js";

const entity = { async *read() {} };

test("entity names may be snake_case, as Airbyte stream names are", () => {
  const connector = defineConnector({
    name: "stripe",
    version: "1.0.0",
    entities: { payment_intents: entity, "web-hooks": entity },
  });
  assert.deepEqual(connector.entityNames(), ["payment_intents", "web-hooks"]);
});

test("a sub-entity is parent:Type, as Close activities are", () => {
  const connector = defineConnector({
    name: "close",
    version: "1.0.0",
    entities: { "activities:Call": entity, "activities:EmailThread": entity },
  });
  assert.deepEqual(connector.entityNames(), [
    "activities:Call",
    "activities:EmailThread",
  ]);
  for (const bad of [
    "Activities:Call",
    "activities:",
    "activities:Call:x",
    ":Call",
  ]) {
    assert.throws(
      () =>
        defineConnector({
          name: "close",
          version: "1",
          entities: { [bad]: entity },
        }),
      /must be lowercase/,
      bad,
    );
  }
});

test("entity names stay lowercase, and the connector name stays a slug", () => {
  assert.throws(
    () =>
      defineConnector({
        name: "acme",
        version: "1",
        entities: { Rows: entity },
      }),
    /entity "Rows" must be lowercase/,
  );
  assert.throws(
    () =>
      defineConnector({
        name: "acme_crm",
        version: "1",
        entities: { rows: entity },
      }),
    /name must be a lowercase slug/,
  );
});

test("spec carries each entity's layout and incremental mode for Mako to index", () => {
  const layout = { partitionField: "_syncedAt", partitionGranularity: "day", clusterFields: ["_dataSourceId", "id"] };
  const spec = defineConnector({
    name: "acme",
    version: "1",
    entities: {
      rows: { ...entity, label: "Rows", layout, incremental: "created-anchor" },
      plain: { ...entity, label: "Plain" },
    },
  }).spec();
  assert.deepEqual(spec.mako.entities.rows, {
    label: "Rows",
    description: undefined,
    layout,
    incremental: "created-anchor",
  });
  assert.equal("layout" in spec.mako.entities.plain, false);
  assert.equal("incremental" in spec.mako.entities.plain, false);
  assert.throws(
    () => defineConnector({ name: "acme", version: "1", entities: { rows: { ...entity, incremental: "sometimes" } } }),
    /incremental must be one of/,
  );
});

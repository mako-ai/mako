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

import { test } from "node:test";
import assert from "node:assert/strict";
import { fieldToJsonSchema, schemaToJsonSchema } from "./protocol.js";

test("shorthand field types map onto JSON Schema, always nullable", () => {
  assert.deepEqual(fieldToJsonSchema("string"), { type: ["null", "string"] });
  assert.deepEqual(fieldToJsonSchema("timestamp"), {
    type: ["null", "string"],
    format: "date-time",
  });
  assert.deepEqual(fieldToJsonSchema("json"), { type: ["null", "object", "array"] });
});

test("an unknown field type names the alternatives instead of failing silently", () => {
  assert.throws(() => fieldToJsonSchema("datetime"), /Unknown field type "datetime".*timestamp/s);
});

test("a raw JSON Schema fragment passes through", () => {
  const raw = { type: "string", enum: ["a", "b"] };
  assert.equal(fieldToJsonSchema(raw), raw);
});

test("no declared schema means open, not empty", () => {
  const schema = schemaToJsonSchema(undefined);
  assert.equal(schema.additionalProperties, true);
  assert.deepEqual(schema.properties, {});
});

test("a shorthand schema becomes a stream schema", () => {
  const schema = schemaToJsonSchema({ id: "string", n: "integer" });
  assert.deepEqual(schema.properties.id, { type: ["null", "string"] });
  assert.deepEqual(schema.properties.n, { type: ["null", "integer"] });
});

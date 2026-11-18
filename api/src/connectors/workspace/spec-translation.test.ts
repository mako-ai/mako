/**
 * The wire speaks JSON Schema; the engine speaks a credential form and
 * `ConnectorEntitySchema`. These are the two translations between them, and
 * they are tested rather than eyeballed because getting them wrong is silent:
 * a missed secret flag stores a credential in plaintext, and a missed
 * date-time lands a timestamp as text no warehouse can partition by.
 *
 * Run: tsx src/connectors/workspace/spec-translation.test.ts
 */
import assert from "node:assert/strict";
import {
  connectionSpecificationToForm,
  jsonSchemaToEntitySchema,
  logicalType,
  primaryKeyOf,
  specToForm,
} from "./spec-translation";
import { MAKO_SYSTEM_FIELDS } from "../base/BaseConnector";

let ran = 0;
let failed = 0;

function test(name: string, body: () => void): void {
  ran++;
  try {
    body();
  } catch (error) {
    failed++;
    console.error(`FAIL ${name}`);
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : String(error),
    );
  }
}

test("a secret becomes an encrypted password field", () => {
  const { fields } = connectionSpecificationToForm({
    type: "object",
    required: ["apiKey"],
    properties: {
      apiKey: { type: "string", title: "API key", airbyte_secret: true },
    },
  });
  assert.deepEqual(fields, [
    {
      name: "apiKey",
      label: "API key",
      type: "password",
      required: true,
      encrypted: true,
    },
  ]);
});

test("required in the spec is required in the form", () => {
  const { fields } = connectionSpecificationToForm({
    required: ["account"],
    properties: { account: { type: "string" }, region: { type: "string" } },
  });
  assert.equal(fields.find(f => f.name === "account")?.required, true);
  assert.equal(fields.find(f => f.name === "region")?.required, false);
});

test("a field with no title still gets a readable label", () => {
  const { fields } = connectionSpecificationToForm({
    properties: {
      api_base_url: { type: "string" },
      maxRetries: { type: "integer" },
    },
  });
  assert.deepEqual(
    fields.map(f => f.label),
    ["Api base url", "Max retries"],
  );
});

test("the spec's declared order wins over object order", () => {
  const { fields } = connectionSpecificationToForm({
    properties: {
      second: { type: "string", order: 2 },
      first: { type: "string", order: 1 },
    },
  });
  assert.deepEqual(
    fields.map(f => f.name),
    ["first", "second"],
  );
});

test("enums, numbers, booleans and multiline text each get their control", () => {
  const { fields } = connectionSpecificationToForm({
    properties: {
      region: { type: "string", enum: ["eu", "us"] },
      limit: { type: "integer", default: 100 },
      verbose: { type: "boolean" },
      pem: { type: "string", multiline: true },
    },
  });
  const byName = Object.fromEntries(fields.map(f => [f.name, f]));
  assert.equal(byName.region.type, "select");
  assert.deepEqual(byName.region.options, [
    { label: "eu", value: "eu" },
    { label: "us", value: "us" },
  ]);
  assert.equal(byName.limit.type, "number");
  assert.equal(byName.limit.default, 100);
  assert.equal(byName.verbose.type, "boolean");
  assert.equal(byName.pem.type, "textarea");
});

/**
 * An empty field list is not a safe answer to an unreadable spec: it is what
 * `applySchemaEncryption` reads as "nothing here is a secret", and the API key
 * then goes to Mongo in plaintext. So the refusal is loud.
 */
test("a multi-line secret is an encrypted textarea, with its rows", () => {
  const { fields } = connectionSpecificationToForm({
    properties: {
      sa: { type: "string", airbyte_secret: true, multiline: true, rows: 10 },
      key: { type: "string", airbyte_secret: true },
    },
  });
  assert.deepEqual(
    fields.map(f => [f.name, f.type, f.encrypted, f.rows]),
    [
      ["sa", "textarea", true, 10],
      ["key", "password", true, undefined],
    ],
  );
});

test("an array of objects is an object_array with its item fields", () => {
  const { fields } = connectionSpecificationToForm({
    properties: {
      queries: {
        type: "array",
        title: "SQL Queries",
        items: {
          type: "object",
          required: ["name"],
          properties: {
            name: { type: "string", title: "Entity Name" },
            token: { type: "string", airbyte_secret: true },
            legacy: { type: "boolean", default: false },
          },
        },
      },
    },
  });
  assert.equal(fields[0].type, "object_array");
  assert.equal(fields[0].label, "SQL Queries");
  assert.deepEqual(
    fields[0].itemFields?.map(f => [f.name, f.type, f.required, f.encrypted]),
    [
      ["name", "string", true, undefined],
      ["token", "password", false, true],
      ["legacy", "boolean", false, undefined],
    ],
  );
});

test("a flow's query form comes from queryEntities, for source flow only", () => {
  const spec = (source: string) => ({
    connectionSpecification: { properties: {} },
    mako: {
      queryEntities: {
        source,
        form: {
          label: "GraphQL Queries",
          required: true,
          items: {
            required: ["query"],
            properties: { query: { type: "string", multiline: true, rows: 8 } },
          },
        },
      },
    },
  });
  const flow = specToForm(spec("flow"));
  assert.equal(flow.transferQueries?.label, "GraphQL Queries");
  assert.equal(flow.transferQueries?.required, true);
  assert.deepEqual(
    flow.transferQueries?.fields.map(f => [f.name, f.type, f.rows, f.required]),
    [["query", "textarea", 8, true]],
  );
  assert.equal(specToForm(spec("connection")).transferQueries, undefined);
  assert.equal(
    specToForm({ connectionSpecification: { properties: {} } }).transferQueries,
    undefined,
  );
});

test("an unreadable spec throws rather than yielding no fields", () => {
  assert.throws(
    () => connectionSpecificationToForm(undefined),
    /connectionSpecification/,
  );
  assert.throws(
    () => connectionSpecificationToForm({ type: "object" }),
    /properties/,
  );
  // A connector that genuinely declares no config is a different thing, and
  // an empty form is the right answer to it.
  assert.deepEqual(
    connectionSpecificationToForm({ type: "object", properties: {} }).fields,
    [],
  );
});

test("a date-time string is a timestamp, so destinations can partition by it", () => {
  assert.equal(
    logicalType({ type: "string", format: "date-time" }),
    "timestamp",
  );
  assert.equal(
    logicalType({ type: ["null", "string"], format: "date" }),
    "timestamp",
  );
});

test("scalar types map straight across", () => {
  assert.equal(logicalType({ type: "integer" }), "integer");
  assert.equal(logicalType({ type: "number" }), "number");
  assert.equal(logicalType({ type: "boolean" }), "boolean");
  assert.equal(logicalType({ type: ["null", "string"] }), "string");
});

test("an untypeable field becomes json rather than being dropped", () => {
  assert.equal(logicalType({ type: "object" }), "json");
  assert.equal(logicalType({}), "json");
  assert.equal(logicalType(undefined), "json");
});

test("an array-of-paths primary key flattens to column names", () => {
  assert.deepEqual(
    primaryKeyOf({ source_defined_primary_key: [["id"], ["tenant_id"]] }),
    ["id", "tenant_id"],
  );
});

test("no declared key is undefined, not an empty array", () => {
  assert.equal(primaryKeyOf({}), undefined);
  assert.equal(primaryKeyOf({ source_defined_primary_key: [] }), undefined);
});

test("a declared stream translates into the engine's vocabulary", () => {
  const schema = jsonSchemaToEntitySchema("people", {
    name: "people",
    source_defined_primary_key: [["id"]],
    json_schema: {
      type: "object",
      required: ["id"],
      properties: {
        id: { type: "string" },
        updated_at: { type: ["null", "string"], format: "date-time" },
        meta: { type: ["null", "object"] },
      },
    },
  });
  assert.equal(schema.entity, "people");
  assert.deepEqual(schema.keyColumns, ["id"]);
  assert.deepEqual(schema.fields.id, {
    type: "string",
    nullable: false,
    required: true,
  });
  assert.deepEqual(schema.fields.updated_at, {
    type: "timestamp",
    nullable: true,
    required: false,
  });
  assert.equal(schema.fields.meta.type, "json");
});

test("a loose stream stays loose instead of failing the sync", () => {
  const schema = jsonSchemaToEntitySchema("events", {
    json_schema: { type: "object", additionalProperties: true },
  });
  // Nothing but Mako's own system columns.
  assert.deepEqual(schema.fields, MAKO_SYSTEM_FIELDS);
  assert.equal(schema.unknownFieldPolicy, "string");
});

test("Mako's system columns are merged in, as in-process schemas spread them", () => {
  const schema = jsonSchemaToEntitySchema("people", {
    json_schema: {
      type: "object",
      properties: {
        id: { type: "string" },
        // A stream field named like a system column does not win.
        is_deleted: { type: "string" },
      },
    },
  });
  for (const [name, field] of Object.entries(MAKO_SYSTEM_FIELDS)) {
    assert.deepEqual(schema.fields[name], field, name);
  }
  assert.equal(schema.fields._syncedAt.type, "timestamp");
  assert.equal(schema.fields.is_deleted.defaultValue, false);
  assert.equal(schema.fields.deleted_at.derivedFrom, "_mako_deleted_at");
  assert.equal(schema.fields.id.type, "string");
});

if (failed > 0) {
  throw new Error(`${failed} of ${ran} spec-translation tests failed`);
}
console.log(`spec-translation: ${ran} tests passed`);

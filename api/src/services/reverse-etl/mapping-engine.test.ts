import assert from "node:assert/strict";
import { assertSchema, contentHash, mapRow } from "./mapping-engine";
import type { ReverseFlowSpec } from "../../schemas/reverse-flow.schema";

const spec: Pick<ReverseFlowSpec, "mappings"> = {
  mappings: [
    {
      target: "name",
      source: { column: "full_name", transform: { ops: ["trim"] } },
      required: true,
    },
    {
      target: "contacts[0].emails[0].email",
      source: { column: "email", transform: { ops: ["trim", "lowercase"] } },
      required: true,
    },
    {
      target: "custom.cf_arr",
      source: { column: "mrr", transform: { ops: ["to_number"] } },
    },
    {
      target: "custom.cf_tier",
      source: {
        column: "plan",
        transform: { lookupMap: { ent: "Enterprise" }, defaultValue: "Other" },
      },
    },
    {
      target: "url",
      source: {
        transform: { template: "https://{{company_domain}}" },
      },
    },
  ],
};

const row = {
  email: " Jane@Acme.com ",
  full_name: " Jane Doe ",
  company_domain: "acme.com",
  plan: "ent",
  mrr: "1200",
  lifecycle_stage: "enterprise",
};

const result = mapRow(spec, row);
assert.deepEqual(result.errors, []);
assert.equal(result.payload.name, "Jane Doe");
assert.deepEqual(result.payload.contacts, [
  { emails: [{ email: "jane@acme.com" }] },
]);
assert.deepEqual(result.payload.custom, {
  cf_arr: 1200,
  cf_tier: "Enterprise",
});
assert.equal(result.payload.url, "https://acme.com");
assert.deepEqual(result.unmappedColumns, ["company_domain", "lifecycle_stage"]);

assert.doesNotThrow(() => assertSchema(spec, Object.keys(row)));
assert.throws(
  () => assertSchema(spec, ["email", "full_name"]),
  /Missing source columns/,
);

assert.equal(contentHash({ b: 2, a: 1 }), contentHash({ a: 1, b: 2 }));

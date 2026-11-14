import { describe, expect, it } from "vitest";
import { buildManifestIndex } from "./manifest-index";
import {
  bigQueryDescriptionsFromRows,
  descriptionsOfNode,
  nodeForRelation,
  parseBigQueryOptionString,
  withDescriptions,
} from "./table-descriptions";
import { ONTOLOGY_MANIFEST } from "../test-support/ontology-fixtures";

const index = buildManifestIndex(ONTOLOGY_MANIFEST);

describe("nodeForRelation", () => {
  it("maps a warehouse table to its dbt node", () => {
    expect(
      nodeForRelation([index], ["acme-prod", "dbt_prod", "dim_account"])?.name,
    ).toBe("dim_account");
    expect(
      nodeForRelation([index], ["acme-prod", "crm_public", "organisations"])
        ?.name,
    ).toBe("crm.organisations");
    expect(nodeForRelation([index], ["dbt_prod", "DIM_ACCOUNT"])?.name).toBe(
      "dim_account",
    );
  });

  it("maps nothing for another schema, a bare table or no manifest", () => {
    expect(
      nodeForRelation([index], ["acme-prod", "dbt_dev", "dim_account"]),
    ).toBeUndefined();
    // The same schema and table on another database is another table.
    expect(
      nodeForRelation([index], ["appdb", "crm_public", "organisations"]),
    ).toBeUndefined();
    expect(nodeForRelation([index], ["dim_account"])).toBeUndefined();
    expect(nodeForRelation([], ["a", "b", "c"])).toBeUndefined();
  });
});

describe("descriptionsOfNode", () => {
  it("returns the node's documented columns, or null when it has none", () => {
    const dim = index.nodes.find(n => n.name === "dim_account");
    const seed = index.nodes.find(n => n.name === "int_subscriptions__periods");
    if (!dim || !seed) throw new Error("fixture");
    expect(descriptionsOfNode(dim)).toEqual({
      source: "dbt",
      description: "One row per account (customer organisation).",
      columns: new Map([["account_id", "Primary key."]]),
      dbtNode: { name: "dim_account", resourceType: "model" },
    });
    expect(descriptionsOfNode({ ...seed, description: undefined })).toBeNull();
  });
});

describe("BigQuery descriptions", () => {
  it("unquotes a table option literal", () => {
    expect(parseBigQueryOptionString('"Orders, one \\"row\\" per order"')).toBe(
      'Orders, one "row" per order',
    );
    expect(parseBigQueryOptionString('"line one\\nline two"')).toBe(
      "line one\nline two",
    );
    expect(parseBigQueryOptionString('""')).toBeUndefined();
    expect(parseBigQueryOptionString(null)).toBeUndefined();
  });

  it("reads the table row and the column rows", () => {
    expect(
      bigQueryDescriptionsFromRows([
        { column_name: "", description: '"All orders"' },
        { column_name: "Order_ID", description: "Primary key" },
        { column_name: "empty", description: " " },
      ]),
    ).toEqual({
      source: "warehouse",
      description: "All orders",
      columns: new Map([["order_id", "Primary key"]]),
    });
    expect(bigQueryDescriptionsFromRows([])).toBeNull();
  });
});

describe("withDescriptions", () => {
  const result = {
    sqlDialect: "bigquery",
    entityKind: "table" as const,
    entityName: "dbt_prod.dim_account",
    database: "dbt_prod",
    fields: [
      { name: "ACCOUNT_ID", types: ["STRING"], nullable: false },
      { name: "name", types: ["STRING"], nullable: true },
    ],
    samples: "| a |",
  };

  it("returns the result untouched when there is nothing to add", () => {
    expect(withDescriptions(result, null)).toBe(result);
  });

  it("adds descriptions and keeps every existing field", () => {
    const described = withDescriptions(result, {
      source: "dbt",
      description: "One row per account.",
      columns: new Map([["account_id", "Primary key."]]),
      dbtNode: { name: "dim_account", resourceType: "model" },
    });
    expect(described).toEqual({
      ...result,
      description: "One row per account.",
      descriptionSource: "dbt",
      dbtNode: { name: "dim_account", resourceType: "model" },
      fields: [
        {
          name: "ACCOUNT_ID",
          types: ["STRING"],
          nullable: false,
          description: "Primary key.",
        },
        { name: "name", types: ["STRING"], nullable: true },
      ],
    });
  });

  it("truncates a long description and says so", () => {
    const described = withDescriptions(result, {
      source: "warehouse",
      description: "word ".repeat(400),
      columns: new Map(),
    });
    expect(described.description?.length).toBeLessThan(1030);
    expect(described.description).toMatch(/… \[truncated\]$/);
  });
});

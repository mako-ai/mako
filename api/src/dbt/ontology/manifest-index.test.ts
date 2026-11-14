import { describe, expect, it } from "vitest";
import {
  buildManifestIndex,
  capList,
  normalizeLayer,
  normalizeRelation,
  resolveNodes,
  searchNodes,
  statedGrain,
  truncateText,
} from "./manifest-index";
import {
  ONTOLOGY_CATALOG,
  ONTOLOGY_MANIFEST,
} from "../test-support/ontology-fixtures";

const index = buildManifestIndex(ONTOLOGY_MANIFEST, ONTOLOGY_CATALOG);
const node = (name: string) => {
  const found = index.nodes.find(n => n.name === name);
  if (!found) throw new Error(`no node ${name}`);
  return found;
};

describe("buildManifestIndex", () => {
  it("indexes models, seeds and sources, and leaves tests out", () => {
    expect(index.nodes.map(n => `${n.resourceType}:${n.name}`)).toEqual([
      "seed:country_codes",
      "source:crm.organisations",
      "model:dim_account",
      "model:fct_account_product_month",
      "model:int_fr_renewals__contract_periods",
      "model:int_subscriptions__periods",
      "source:stripe.subscriptions",
    ]);
    expect(index.generatedAt).toBe("2026-11-12T04:00:00Z");
    expect(index.hasCatalog).toBe(true);
  });

  it("keeps what describes a model", () => {
    const fct = node("fct_account_product_month");
    expect(fct).toMatchObject({
      id: "model.analytics.fct_account_product_month",
      layer: "marts",
      path: "models/marts/finance/fct_account_product_month.sql",
      grain: "account x product x month",
      tags: ["finance", "governed"],
      meta: { owner: "finance" },
      group: "finance",
      access: "public",
      contractEnforced: true,
      materialized: "table",
      relationName: "`acme-prod`.`dbt_prod`.`fct_account_product_month`",
      relationKey: "acme-prod.dbt_prod.fct_account_product_month",
      relationTable: "fct_account_product_month",
      parents: ["dim_account", "int_subscriptions__periods"],
      children: [],
      tests: ["dbt_utils.unique_combination_of_columns"],
      exposures: [
        {
          name: "Finance dashboard",
          type: "dashboard",
          url: "https://example.test/finance",
          owner: "Finance",
        },
      ],
    });
  });

  it("takes column types from the catalog and tests from test nodes", () => {
    expect(node("fct_account_product_month").columns).toEqual([
      {
        name: "account_id",
        description: "The paying account.",
        type: "STRING",
        tests: ["not_null"],
      },
      {
        name: "product",
        description: "Subscription product.",
        type: "STRING",
        tests: [],
      },
      { name: "month", type: "DATE", tests: [] },
      {
        name: "mrr_eur",
        description: "Monthly recurring revenue in EUR, VAT excluded.",
        type: "NUMERIC",
        tests: [],
      },
      // In the warehouse, not in the YAML.
      { name: "loaded_at", type: "TIMESTAMP", tests: [] },
    ]);
    expect(node("dim_account").columns[0].tests).toEqual(["unique"]);
  });

  it("falls back to the manifest's data_type without a catalog", () => {
    const bare = buildManifestIndex(ONTOLOGY_MANIFEST);
    expect(bare.hasCatalog).toBe(false);
    const month = bare.nodes
      .find(n => n.name === "fct_account_product_month")
      ?.columns.find(c => c.name === "month");
    expect(month).toEqual({ name: "month", type: "date", tests: [] });
  });

  it("links lineage both ways, sources included", () => {
    expect(node("dim_account").parents).toEqual(["crm.organisations"]);
    expect(node("dim_account").children).toEqual(["fct_account_product_month"]);
    expect(node("stripe.subscriptions").children).toEqual([
      "int_subscriptions__periods",
    ]);
  });

  it("names layers from the path, the resource type or the prefix", () => {
    expect(node("int_subscriptions__periods").layer).toBe("intermediate");
    expect(node("country_codes").layer).toBe("seed");
    expect(node("stripe.subscriptions").layer).toBe("source");
    const flat = buildManifestIndex({
      nodes: {
        "model.a.stg_orders": {
          name: "stg_orders",
          resource_type: "model",
          original_file_path: "models/stg_orders.sql",
        },
      },
    });
    expect(flat.nodes[0].layer).toBe("staging");
  });

  it("survives an empty or partial manifest", () => {
    expect(buildManifestIndex({}).nodes).toEqual([]);
    const partial = buildManifestIndex({
      nodes: { "model.a.x": {}, "macro.a.y": { resource_type: "macro" } },
    });
    expect(partial.nodes.map(n => n.name)).toEqual(["x"]);
  });
});

describe("statedGrain", () => {
  it("reads meta.grain, then the description", () => {
    expect(statedGrain({ grain: "order" }, "Grain: other.")).toBe("order");
    expect(statedGrain({ grain: ["account_id", "month"] }, undefined)).toBe(
      "account_id x month",
    );
    expect(statedGrain({}, "Orders. Grain: one order line. More.")).toBe(
      "one order line",
    );
    expect(statedGrain({}, "One row per subscription period.")).toBe(
      "One row per subscription period",
    );
    expect(statedGrain({}, "Nothing stated.")).toBeUndefined();
    expect(node("dim_account").grain).toBe("account_id");
  });
});

describe("resolveNodes", () => {
  const names = (name: string) => resolveNodes(index, name).map(n => n.name);

  it("finds a node by unique id, name, source name or relation", () => {
    expect(names("model.analytics.dim_account")).toEqual(["dim_account"]);
    expect(names("DIM_ACCOUNT")).toEqual(["dim_account"]);
    expect(names("stripe.subscriptions")).toEqual(["stripe.subscriptions"]);
    expect(names("`acme-prod`.`dbt_prod`.`dim_account`")).toEqual([
      "dim_account",
    ]);
    expect(names("dbt_prod.dim_account")).toEqual(["dim_account"]);
    expect(names("crm_public.organisations")).toEqual(["crm.organisations"]);
    expect(names("organisations")).toEqual(["crm.organisations"]);
  });

  it("finds nothing for an unknown name or another schema", () => {
    expect(names("fct_nope")).toEqual([]);
    expect(names("dbt_dev.dim_account")).toEqual([]);
    expect(names("  ")).toEqual([]);
  });
});

describe("searchNodes", () => {
  const top = (query: string, layer?: string) =>
    searchNodes(index, query, { layer }).map(hit => hit.node.name);

  it("searches names, descriptions, columns, tags and meta", () => {
    expect(top("account product")[0]).toBe("fct_account_product_month");
    expect(top("recurring revenue")[0]).toBe("fct_account_product_month");
    expect(top("subscription_id")[0]).toBe("int_subscriptions__periods");
    expect(top("governed")).toEqual(["fct_account_product_month"]);
    expect(top("finance")).toEqual(["fct_account_product_month"]);
    expect(top("iso country")).toEqual(["country_codes"]);
  });

  it("says which fields matched", () => {
    const [hit] = searchNodes(index, "mrr_eur");
    expect(hit.node.name).toBe("fct_account_product_month");
    expect(hit.matchedOn).toEqual(
      expect.arrayContaining(["columns", "column_descriptions"]),
    );
  });

  it("puts an exact name or relation first", () => {
    expect(top("dim_account")[0]).toBe("dim_account");
    expect(top("acme-prod.dbt_prod.dim_account")[0]).toBe("dim_account");
  });

  it("matches the extra words a caller attaches (registry synonyms)", () => {
    const hits = searchNodes(index, "organisation", {
      extraWords: n =>
        n.name === "dim_account" ? "customer organisation" : "",
    });
    const dim = hits.find(hit => hit.node.name === "dim_account");
    expect(dim?.matchedOn).toContain("registry");
  });

  it("filters by layer, with the usual aliases", () => {
    expect(top("subscriptions", "source")).toEqual(["stripe.subscriptions"]);
    expect(top("subscriptions", "int")).toEqual(["int_subscriptions__periods"]);
    expect(top("account", "marts").sort()).toEqual([
      "dim_account",
      "fct_account_product_month",
    ]);
    expect(top("account", "finance")).toEqual(["fct_account_product_month"]);
    expect(top("account", "staging")).toEqual([]);
    expect(normalizeLayer("Sources")).toBe("source");
  });

  it("returns nothing for a query with no words", () => {
    expect(top("the of")).toEqual([]);
    expect(top("zzzz")).toEqual([]);
  });
});

describe("compacting", () => {
  it("normalizes relations", () => {
    expect(normalizeRelation('"Db"."Public"."Users"')).toBe("db.public.users");
    expect(normalizeRelation("`p.{{ dbt_schema }}.t`")).toBe(
      "p.{{dbt_schema}}.t",
    );
  });

  it("cuts long text on a word and marks the cut", () => {
    expect(truncateText("short", 20)).toBe("short");
    expect(truncateText("  two\n lines ", 20)).toBe("two lines");
    const cut = truncateText("alpha beta gamma delta epsilon", 18);
    expect(cut).toBe("alpha beta gamma… [truncated]");
    expect(truncateText(undefined, 5)).toBeUndefined();
  });

  it("caps lists and keeps the total", () => {
    expect(capList([1, 2, 3], 2)).toEqual({
      items: [1, 2],
      total: 3,
      truncated: true,
    });
    expect(capList([1], 2).truncated).toBe(false);
  });
});

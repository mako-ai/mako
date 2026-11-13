import { describe, expect, it } from "vitest";
import { extractTables } from "../../apps/app-search";
import { buildManifestIndex } from "./manifest-index";
import {
  bindingReadsOf,
  readerCountsByNode,
  readersOfNode,
  readersOfRelation,
  referenceReadsNode,
  referenceReadsRelation,
  type AppBindingReads,
} from "./model-readers";
import { ONTOLOGY_MANIFEST } from "../test-support/ontology-fixtures";

const index = buildManifestIndex(ONTOLOGY_MANIFEST);
const node = (name: string) => {
  const found = index.nodes.find(n => n.name === name);
  if (!found) throw new Error(`no node ${name}`);
  return found;
};

const app = (
  path: string,
  bindings: Record<string, string>,
): AppBindingReads => ({
  appId: path,
  path,
  title: path,
  bindings: Object.entries(bindings).map(([binding, sql]) => ({
    binding,
    tables: extractTables(sql),
  })),
});

const APPS = [
  app("apps/finance/mrr", {
    mrr: "select * from {{ dbt_schema }}.fct_account_product_month",
    accounts:
      "select * from `acme-prod.{{ dbt_schema }}.dim_account` a join `acme-prod`.`crm_public`.`organisations` o using (id)",
  }),
  app("apps/sales/accounts", {
    rows: "select * from dbt_prod.dim_account",
    raw: "select * from `acme-prod.stripe.subscriptions`",
  }),
  app("users/ana/apps/scratch", {
    q: "select * from other_dataset.dim_account join dim_account using (id)",
    legacy: "select * from analytics_legacy.orders",
  }),
];

describe("referenceReadsNode", () => {
  it("resolves the three ways a binding names a dbt model", () => {
    const dim = node("dim_account");
    for (const ref of [
      "{{dbt_schema}}.dim_account",
      "acme-prod.{{dbt_schema}}.dim_account",
      "`acme-prod`.`dbt_prod`.`dim_account`",
      "acme-prod.dbt_prod.dim_account",
      "dbt_prod.dim_account",
      "DBT_PROD.DIM_ACCOUNT",
    ]) {
      expect(referenceReadsNode(ref, dim), ref).toBe(true);
    }
  });

  it("does not attribute another schema, another table or a bare name", () => {
    const dim = node("dim_account");
    for (const ref of [
      "other_dataset.dim_account",
      "dbt_prod.dim_account_v2",
      "other-project.dbt_prod.dim_account",
      "dim_account",
    ]) {
      expect(referenceReadsNode(ref, dim), ref).toBe(false);
    }
  });

  it("never reads a source through the templated dbt schema", () => {
    const source = node("crm.organisations");
    expect(referenceReadsNode("{{dbt_schema}}.organisations", source)).toBe(
      false,
    );
    expect(referenceReadsNode("crm_public.organisations", source)).toBe(true);
  });
});

describe("referenceReadsRelation", () => {
  it("matches a raw table with or without its project", () => {
    expect(
      referenceReadsRelation(
        "p.analytics_legacy.orders",
        "analytics_legacy.orders",
      ),
    ).toBe(true);
    expect(
      referenceReadsRelation(
        "analytics_legacy.orders",
        "p.analytics_legacy.orders",
      ),
    ).toBe(true);
    expect(
      referenceReadsRelation(
        "analytics_legacy.orders",
        "`analytics_legacy`.`orders`",
      ),
    ).toBe(true);
    expect(referenceReadsRelation("x.orders", "analytics_legacy.orders")).toBe(
      false,
    );
    expect(referenceReadsRelation("analytics_legacy.orders", "orders")).toBe(
      false,
    );
  });
});

describe("readers", () => {
  it("lists the apps and binding files that read a model", () => {
    expect(readersOfNode(APPS, node("dim_account"))).toEqual([
      {
        appId: "apps/finance/mrr",
        path: "apps/finance/mrr",
        title: "apps/finance/mrr",
        bindings: ["apps/finance/mrr/bindings/accounts.sql"],
      },
      {
        appId: "apps/sales/accounts",
        path: "apps/sales/accounts",
        title: "apps/sales/accounts",
        bindings: ["apps/sales/accounts/bindings/rows.sql"],
      },
    ]);
    expect(
      readersOfNode(APPS, node("fct_account_product_month")).map(
        r => r.bindings,
      ),
    ).toEqual([["apps/finance/mrr/bindings/mrr.sql"]]);
    expect(readersOfNode(APPS, node("country_codes"))).toEqual([]);
  });

  it("lists the readers of a source and of a raw table", () => {
    expect(
      readersOfNode(APPS, node("stripe.subscriptions")).map(r => r.path),
    ).toEqual(["apps/sales/accounts"]);
    expect(
      readersOfNode(APPS, node("crm.organisations")).map(r => r.path),
    ).toEqual(["apps/finance/mrr"]);
    expect(readersOfRelation(APPS, "analytics_legacy.orders")).toEqual([
      {
        appId: "users/ana/apps/scratch",
        path: "users/ana/apps/scratch",
        title: "users/ana/apps/scratch",
        bindings: ["users/ana/apps/scratch/bindings/legacy.sql"],
      },
    ]);
  });

  it("counts reading apps per node in one pass, agreeing with the lists", () => {
    const counts = readerCountsByNode(index, APPS);
    for (const n of index.nodes) {
      expect(counts.get(n.id) ?? 0, n.name).toBe(readersOfNode(APPS, n).length);
    }
    expect(counts.get("model.analytics.dim_account")).toBe(2);
  });

  it("reads nothing from an index row built before per-binding tables", () => {
    expect(
      bindingReadsOf({ appId: "a", path: "apps/a", title: "A" }).bindings,
    ).toEqual([]);
  });
});

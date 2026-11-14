/**
 * What the dbt Rename dialog says while a path is typed: where the file
 * will go, or the server's own sentence for why it cannot go there.
 */
import { describe, expect, it } from "vitest";
import {
  dbtNodeNameOf,
  filesReferringTo,
  leavesNodeWarning,
  resolveDbtRenameTarget,
  splitRenameWarning,
} from "./dbt-rename-path";

const FROM = "models/marts/order_counts.sql";
const FILES = [
  FROM,
  "models/marts/fct_orders.sql",
  "models/staging/stg_orders.sql",
  "dbt_project.yml",
];
const target = (typed: string) => resolveDbtRenameTarget(typed, FROM, FILES);

describe("resolveDbtRenameTarget", () => {
  it("takes the full project path, in every spelling of it", () => {
    for (const typed of [
      "models/staging/order_counts.sql",
      "/models/staging/order_counts.sql",
      "dbt/models/staging/order_counts.sql",
      "  models//staging/./order_counts.sql ",
      "models/marts/../staging/order_counts.sql",
    ]) {
      expect([typed, target(typed)]).toEqual([
        typed,
        { ok: true, path: "models/staging/order_counts.sql", unchanged: false },
      ]);
    }
    // Its own path, however spelled, is nothing to do; its own name in
    // another case is a rename.
    expect(target(`/dbt/${FROM}`)).toEqual({
      ok: true,
      path: FROM,
      unchanged: true,
    });
    expect(target("models/marts/Order_Counts.sql")).toMatchObject({
      ok: true,
      unchanged: false,
    });
  });

  it("refuses in plain sentences", () => {
    for (const [typed, error] of [
      ["", "Give the file a path."],
      ["../x.sql", "The path must stay inside the dbt project."],
      ["models/../../x.sql", "The path must stay inside the dbt project."],
      ["models\\x.sql", "Use / to separate folders, not \\."],
      ["models/staging/", "End the path with a file name, not a folder."],
      ["models/.git/x", "The path can't go inside .git."],
      ["models/marts/fct_orders.sql", "A file already exists there."],
      ["models/staging", "A folder already exists there."],
      ["dbt_project.yml/x.sql", "dbt_project.yml is a file, not a folder."],
      ["models/CON.sql", '"CON.sql" is a reserved name on Windows.'],
    ]) {
      expect([typed, target(typed)]).toEqual([typed, { ok: false, error }]);
    }
    for (const [typed, said] of [
      ["models/a:b.sql", "not allowed in a file name"],
      ["models/x.sql.", "ends with a dot"],
      ["models/marts/FCT_orders.sql", "upper/lower case"],
      ["Models/x.sql", "upper/lower case"],
    ]) {
      expect(target(typed)).toEqual({
        ok: false,
        error: expect.stringContaining(said),
      });
    }
  });
});

describe("what a rename is, and what it warns of", () => {
  it("a model or a seed names a dbt node; a snapshot and a YAML file do not", () => {
    expect(dbtNodeNameOf("models/marts/orders.sql")).toBe("orders");
    expect(dbtNodeNameOf("seeds/countries.csv")).toBe("countries");
    expect(dbtNodeNameOf("snapshots/orders.sql")).toBeNull();
    expect(dbtNodeNameOf("models/schema.yml")).toBeNull();
  });

  it("warns before a model or a seed is renamed to a path that names no node", () => {
    expect(leavesNodeWarning("models/orders.sql", "models/report")).toBe(
      "models/report is not a model path, so the file stops being the model 'orders'. ref('orders') calls, job selectors and its schema entry are left as they are and will not resolve.",
    );
    expect(
      leavesNodeWarning("models/orders.sql", "docs/orders.sql", [
        "models/mart.sql",
      ]),
    ).toMatch(/ Among the files open here, models\/mart\.sql refers to it\.$/);
    expect(
      leavesNodeWarning("seeds/countries.csv", "seeds/countries.txt", [
        "a.sql",
        "b.sql",
      ]),
    ).toMatch(
      /stops being the seed 'countries'.*a\.sql, b\.sql refer to it\.$/,
    );
    // Still a node afterwards, or never one: nothing to say.
    for (const [from, to] of [
      ["models/orders.sql", "models/marts/fct_orders.sql"],
      ["models/orders.sql", "models/orders.py"],
      ["models/schema.yml", "models/props"],
      ["snapshots/orders.sql", "snapshots/orders"],
    ]) {
      expect([from, to, leavesNodeWarning(from, to)]).toEqual([from, to, null]);
    }
  });

  it("knows which files loaded here ref() a model, and claims nothing about the rest", () => {
    const files = {
      "models/orders.sql": { content: "-- ref('orders')", loaded: true },
      "models/mart.sql": { content: "from {{ ref('orders') }}", loaded: true },
      "models/pkg.sql": { content: 'from {{ ref("a", "orders") }}' },
      "models/other.sql": { content: "from {{ ref('orders_v2') }} orders" },
      "models/unloaded.sql": { content: "", loaded: false },
    };
    expect(filesReferringTo("models/orders.sql", files)).toEqual([
      "models/mart.sql",
      "models/pkg.sql",
    ]);
    expect(filesReferringTo("models/schema.yml", files)).toEqual([]);
  });

  it("a warning is one sentence, then its detail", () => {
    expect(splitRenameWarning("One sentence.")).toEqual({
      message: "One sentence.",
    });
    expect(
      splitRenameWarning("Move that config.\nDetail: models.a.staging\nmore"),
    ).toEqual({
      message: "Move that config.",
      detail: "Detail: models.a.staging\nmore",
    });
  });
});

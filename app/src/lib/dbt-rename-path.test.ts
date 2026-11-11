/**
 * What the dbt Rename dialog says while a path is typed: where the file
 * will go, or the server's own sentence for why it cannot go there.
 */
import { describe, expect, it } from "vitest";
import {
  dbtNodeNameOf,
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

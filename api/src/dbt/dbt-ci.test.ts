import { describe, expect, it } from "vitest";
import { changedModelSelectors } from "./dbt-ci.service";

describe("changedModelSelectors (Slim CI fallback selection)", () => {
  it("maps changed models to downstream selectors (name+) and dedups", () => {
    expect(
      changedModelSelectors([
        "models/staging/stg_orders.sql",
        "models/marts/fct_orders.sql",
      ]),
    ).toEqual(["stg_orders+", "fct_orders+"]);
  });

  it("ignores non-model and non-sql changes", () => {
    expect(
      changedModelSelectors([
        "models/a.sql",
        "macros/util.sql",
        "models/schema.yml",
        "README.md",
        "seeds/data.csv",
      ]),
    ).toEqual(["a+"]);
  });

  it("strips a configured subdirectory prefix before matching", () => {
    expect(
      changedModelSelectors(
        ["analytics/models/staging/stg.sql", "other/models/x.sql"],
        "analytics",
      ),
    ).toEqual(["stg+"]);
  });

  it("dedupes the same model touched twice", () => {
    expect(changedModelSelectors(["models/a.sql", "models/sub/a.sql"])).toEqual(
      ["a+"],
    );
  });

  it("returns [] when nothing dbt-relevant changed", () => {
    expect(changedModelSelectors(["README.md", "package.json"])).toEqual([]);
    expect(changedModelSelectors([])).toEqual([]);
  });
});

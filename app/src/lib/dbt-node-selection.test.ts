import { describe, expect, it } from "vitest";
import {
  buildDbtNodeCommand,
  buildDbtSelectArg,
  type DbtSelectScope,
} from "./dbt-node-selection";

describe("buildDbtSelectArg — graph operators", () => {
  const cases: Array<[DbtSelectScope, string]> = [
    ["", "fct_orders"],
    ["down", "fct_orders+"],
    ["up", "+fct_orders"],
    ["both", "+fct_orders+"],
  ];
  it.each(cases)("scope %s → %s", (scope, expected) => {
    expect(buildDbtSelectArg("fct_orders", scope)).toBe(expected);
  });
});

describe("buildDbtNodeCommand", () => {
  it("composes verb + --select with the scoped node", () => {
    expect(buildDbtNodeCommand("build", "fct_orders", "both")).toBe(
      "build --select +fct_orders+",
    );
    expect(buildDbtNodeCommand("run", "stg_orders", "down")).toBe(
      "run --select stg_orders+",
    );
    expect(buildDbtNodeCommand("test", "dim_users", "")).toBe(
      "test --select dim_users",
    );
  });

  it("appends --full-refresh for build/run but never for test", () => {
    expect(
      buildDbtNodeCommand("build", "fct_orders", "", { fullRefresh: true }),
    ).toBe("build --select fct_orders --full-refresh");
    expect(
      buildDbtNodeCommand("run", "fct_orders", "down", { fullRefresh: true }),
    ).toBe("run --select fct_orders+ --full-refresh");
    expect(
      buildDbtNodeCommand("test", "fct_orders", "", { fullRefresh: true }),
    ).toBe("test --select fct_orders");
    expect(
      buildDbtNodeCommand("build", "fct_orders", "", { fullRefresh: false }),
    ).toBe("build --select fct_orders");
  });

  it("builds show with --limit and ignores graph scope / full-refresh", () => {
    expect(buildDbtNodeCommand("show", "stg_orders", "both")).toBe(
      "show --select stg_orders --limit 100",
    );
    expect(
      buildDbtNodeCommand("show", "stg_orders", "down", {
        fullRefresh: true,
        limit: 25,
      }),
    ).toBe("show --select stg_orders --limit 25");
  });
});

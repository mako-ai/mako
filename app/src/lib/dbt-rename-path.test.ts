import { describe, expect, it } from "vitest";
import { resolveDbtRenameTarget, splitRenameWarning } from "./dbt-rename-path";

const FROM = "models/marts/order_counts.sql";
const FILES = [
  FROM,
  "models/marts/fct_orders.sql",
  "models/staging/stg_orders.sql",
  "models/staging/Report.sql",
  "dbt_project.yml",
];
const at = (typed: string) => resolveDbtRenameTarget(typed, FROM, FILES);

describe("resolveDbtRenameTarget — the full project path the dialog sends", () => {
  it("a path typed from the project root goes exactly there (never nested under the current folder)", () => {
    expect(at("models/staging/order_counts.sql")).toEqual({
      ok: true,
      path: "models/staging/order_counts.sql",
      unchanged: false,
    });
  });

  it("normalizes a leading /, dbt/, ./, //, surrounding spaces and .. that stays inside", () => {
    for (const typed of [
      "/models/staging/x.sql",
      "dbt/models/staging/x.sql",
      "/dbt/models/staging/x.sql",
      "./models/staging/x.sql",
      "models//staging/x.sql",
      "  models/staging/x.sql  ",
      "models/marts/../staging/x.sql",
    ]) {
      expect([typed, at(typed)]).toEqual([
        typed,
        { ok: true, path: "models/staging/x.sql", unchanged: false },
      ]);
    }
  });

  it("refuses, in plain words, what cannot be a file inside the project", () => {
    const cases: Array<[string, RegExp]> = [
      ["", /Give the file a path/],
      ["../staging/x.sql", /must stay inside the dbt project/],
      ["models/../../x.sql", /must stay inside the dbt project/],
      ["models\\x.sql", /Use \/ to separate folders/],
      ["models/staging/", /End the path with a file name/],
      ["models/a:b.sql", /not allowed in a file name/],
      ["models/CON.sql", /reserved name/],
      ["models/x.sql.", /ends with a dot/],
      ["models/ x.sql", /starts or ends with a space/],
      [".git/config", /inside \.git/],
      ["models/a\nb.sql", /control characters/],
      ["models/marts/fct_orders.sql", /A file already exists there/],
      ["models/staging", /A folder already exists there/],
      ["dbt_project.yml/x.sql", /dbt_project\.yml is a file, not a folder/],
      [
        "models/staging/report.sql",
        /models\/staging\/Report\.sql already exists/,
      ],
    ];
    for (const [typed, reason] of cases) {
      const r = at(typed);
      expect([JSON.stringify(typed), r.ok]).toEqual([
        JSON.stringify(typed),
        false,
      ]);
      if (!r.ok) expect(r.error).toMatch(reason);
    }
  });

  it("its own path is unchanged; its own name in another case is a rename", () => {
    expect(at(`/${FROM}`)).toEqual({ ok: true, path: FROM, unchanged: true });
    expect(at("models/marts/Order_Counts.sql")).toMatchObject({
      ok: true,
      unchanged: false,
    });
  });
});

describe("splitRenameWarning", () => {
  it("the first line is the message, the rest is detail", () => {
    expect(
      splitRenameWarning("Plain.\nDetail: models.analytics.marts"),
    ).toEqual({
      message: "Plain.",
      detail: "Detail: models.analytics.marts",
    });
    expect(splitRenameWarning("Just this.")).toEqual({ message: "Just this." });
  });
});

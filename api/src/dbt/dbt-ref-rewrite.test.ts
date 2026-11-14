/**
 * Renaming a model rewrites `ref()`s, job selectors, its properties entry
 * and its `dbt_project.yml` key, and nothing else.
 */
import * as yaml from "js-yaml";
import { describe, expect, it } from "vitest";
import { parseDbtCommand } from "./commands";
import { parseJobFile, serializeJobFile } from "./dbt-config-files";
import {
  mentionsName,
  projectConfigsLostByMove,
  refNameForDbtPath,
  renamedScalarsAreStrings,
  rewriteJobCommands,
  rewriteNodeProperties,
  rewriteProjectModelConfig,
  rewriteRefs,
  rewriteSelectors,
  selectorsStillNaming,
} from "./dbt-ref-rewrite";

describe("refNameForDbtPath", () => {
  it("names SQL/Python models and seeds; a snapshot is named by its block", () => {
    expect(refNameForDbtPath("models/marts/orders.sql")).toBe("orders");
    expect(refNameForDbtPath("models/ml/churn.py")).toBe("churn");
    expect(refNameForDbtPath("seeds/countries.csv")).toBe("countries");
    for (const path of [
      "snapshots/orders.sql",
      "models/schema.yml",
      "macros/orders.sql",
      "dbt_project.yml",
    ]) {
      expect([path, refNameForDbtPath(path)]).toEqual([path, null]);
    }
  });
});

describe("rewriteRefs", () => {
  it("rewrites both quote styles, inner whitespace, the version kwargs and comments", () => {
    const sql = [
      "select * from {{ ref('orders') }}",
      'join {{ ref("orders") }} using (id)',
      "left join {{ ref( 'orders' ) }} o on 1=1",
      "-- {{ref('orders')}} in a comment is stale too",
      "{{ ref('orders', v=2) }} {{ ref('orders', version=1) }}",
    ].join("\n");
    const r = rewriteRefs(sql, "orders", "fct_orders");
    expect(r.count).toBe(6);
    expect(r.text).toBe(sql.replaceAll("orders", "fct_orders"));
  });

  it("rewrites the two-argument form only when the package is this project", () => {
    const sql =
      "{{ ref('analytics', 'orders') }} {{ ref('other_pkg', 'orders') }} {{ ref(\"analytics\", \"orders\") }}";
    const r = rewriteRefs(sql, "orders", "fct_orders", "analytics");
    expect(r.count).toBe(2);
    expect(r.text).toBe(
      "{{ ref('analytics', 'fct_orders') }} {{ ref('other_pkg', 'orders') }} {{ ref(\"analytics\", \"fct_orders\") }}",
    );
    expect(rewriteRefs(sql, "orders", "fct_orders").count).toBe(0);
  });

  it("leaves other names, sources, plain SQL and a package of that name alone", () => {
    const sql = [
      "{{ ref('orders_suffix') }}",
      "{{ ref('orders2') }}",
      "{{ ref('prefix_orders') }}",
      "{{ source('orders', 'raw') }}",
      "select * from analytics.orders",
      "{{ ref('orders', 'x') }}",
      "{{ ref('aXb') }}",
    ].join("\n");
    expect(rewriteRefs(sql, "orders", "fct_orders", "analytics")).toEqual({
      text: sql,
      count: 0,
    });
    // A dot in a name is a dot, not "any character".
    expect(rewriteRefs(sql, "a.b", "c").count).toBe(0);
  });
});

describe("rewriteSelectors", () => {
  it("rewrites bare names and graph operators after selector flags", () => {
    const cases: Array<[string, string]> = [
      ["dbt run --select orders", "dbt run --select fct_orders"],
      ["dbt run -s orders+", "dbt run -s fct_orders+"],
      ["dbt run --select 2+orders+3", "dbt run --select 2+fct_orders+3"],
      ["dbt run --select @orders", "dbt run --select @fct_orders"],
      ["dbt run --select orders,other", "dbt run --select fct_orders,other"],
      [
        'dbt run --select "orders tag:daily"',
        'dbt run --select "fct_orders tag:daily"',
      ],
      ["dbt run --select=orders,x", "dbt run --select=fct_orders,x"],
      [
        "dbt build --models orders --exclude orders",
        "dbt build --models fct_orders --exclude fct_orders",
      ],
      [
        "dbt   run  --select   orders   --full-refresh",
        "dbt   run  --select   fct_orders   --full-refresh",
      ],
    ];
    for (const [input, expected] of cases) {
      expect(rewriteSelectors(input, "orders", "fct_orders").text).toBe(
        expected,
      );
    }
  });

  it("rewrites every selector after one --select, the form the job parser accepts", () => {
    const command =
      "run --select stg_a orders+ +orders --exclude orders tag:x --full-refresh";
    // The fixture is a command master's parser takes (several values).
    expect(() => parseDbtCommand(command)).not.toThrow();
    const r = rewriteSelectors(command, "orders", "fct_orders");
    expect(r.count).toBe(3);
    expect(r.text).toBe(
      "run --select stg_a fct_orders+ +fct_orders --exclude fct_orders tag:x --full-refresh",
    );
    expect(() => parseDbtCommand(r.text)).not.toThrow();
  });

  it("leaves method selectors, other names and non-selector arguments alone", () => {
    for (const input of [
      "dbt run --select tag:orders",
      "dbt run --select fqn:orders",
      "dbt run --select orders_daily orders2",
      "dbt run --target orders",
      'dbt run --vars \'{"model": "orders"}\'',
      "dbt run --select other --target orders",
    ]) {
      expect(rewriteSelectors(input, "orders", "fct_orders")).toEqual({
        text: input,
        count: 0,
      });
    }
    expect(
      selectorsStillNaming("dbt run --select marts.orders x", "orders"),
    ).toEqual(["marts.orders"]);
    expect(
      selectorsStillNaming("dbt run --select fqn:orders tag:x", "orders"),
    ).toEqual(["fqn:orders"]);
    expect(
      selectorsStillNaming("dbt run --target orders -s orders_x", "orders"),
    ).toEqual([]);
  });
});

describe("rewriteNodeProperties", () => {
  const SCHEMA = [
    "version: 2",
    "models:",
    "  - name: orders  # the fact table",
    "    columns:",
    "      - name: orders",
    "  - name: orders_archive",
    '  - name: "customers"',
    "seeds:",
    "  - name: orders",
    "sources:",
    "  - name: orders",
    "    tables:",
    "      - name: orders",
    "snapshots:",
    "  - name: orders",
    "unit_tests:",
    "  - name: t",
    "    model: orders",
    "    given:",
    "      - input: ref('orders')",
    "    overrides:",
    "      macros:",
    "        model: orders",
    "  - name: other",
    "    model: 'orders'  # quoted",
    "  - name: unrelated",
    "    model: orders_v2",
    "",
  ].join("\n");

  it("renames the node's entry under models/seeds and `model:` in unit tests, nothing deeper", () => {
    const r = rewriteNodeProperties(SCHEMA, "orders", "fct_orders");
    expect(r.count).toBe(4);
    expect(r.text).toBe(
      SCHEMA.replace(
        "  - name: orders  # the fact table",
        "  - name: fct_orders  # the fact table",
      )
        .replace("seeds:\n  - name: orders", "seeds:\n  - name: fct_orders")
        .replace(
          "    model: orders\n    given",
          "    model: fct_orders\n    given",
        )
        .replace("model: 'orders'  # quoted", "model: 'fct_orders'  # quoted"),
    );
    // The author's quotes stay; a file that does not name it is untouched.
    expect(
      rewriteNodeProperties(SCHEMA, "customers", "dim_customers").text,
    ).toContain('  - name: "dim_customers"\n');
    expect(rewriteNodeProperties(SCHEMA, "nothing_here", "x")).toEqual({
      text: SCHEMA,
      count: 0,
    });
  });

  it("a CRLF file is rewritten and keeps its line endings", () => {
    const crlf =
      "version: 2\r\nmodels:\r\n  - name: orders\r\n    description: d\r\n";
    expect(rewriteNodeProperties(crlf, "orders", "fct_orders").text).toBe(
      crlf.replace("orders", "fct_orders"),
    );
  });
});

describe("rewriteJobCommands: the file is the author's", () => {
  const JOB = [
    "# nightly build",
    "name: Daily",
    "description: Runs everything.  # a key the job parser does not know",
    "environment: dev",
    "commands:",
    "  - dbt deps",
    "  - dbt run --select orders+  # the fact table first",
    "  - 'dbt test -s customers,orders'",
    '  - "dbt run --select \\"orders tag:x\\""',
    "  - dbt run --select marts.orders",
    "  # - dbt run -s orders",
    "  - |",
    "    dbt run --select orders",
    "enabled: true",
    "",
  ].join("\n");

  it("rewrites the command lines only; comments and unknown keys survive", () => {
    const r = rewriteJobCommands(JOB, "orders", "fct_orders");
    expect(r.count).toBe(3);
    expect(r.text).toBe(
      JOB.replace(
        "  - dbt run --select orders+  # the fact table first",
        "  - dbt run --select fct_orders+  # the fact table first",
      )
        .replace("customers,orders'", "customers,fct_orders'")
        .replace(
          "  - |\n    dbt run --select orders",
          '  - "dbt run --select fct_orders"',
        ),
    );
    // A quoted command with escapes is reported, not guessed at.
    expect(r.unrewritable).toEqual(['"dbt run --select \\"orders tag:x\\""']);
  });

  it("a folded block, as serializeJobFile writes a long command, becomes one quoted line", () => {
    const long =
      "dbt build --select orders+ stg_customers stg_payments stg_products stg_suppliers dim_dates fct_events --exclude tag:x";
    const other =
      "dbt run --select stg_customers stg_payments stg_products stg_suppliers dim_dates fct_events fct_sessions --exclude tag:slow";
    const job = serializeJobFile({
      name: "nightly",
      environment: "prod",
      commands: [long, "dbt run -s orders", other],
      schedule: null,
      enabled: true,
      deferToProduction: false,
    });
    expect(job).toMatch(/- >-\n/);
    const r = rewriteJobCommands(job, "orders", "fct_orders");
    expect(r).toMatchObject({ count: 2, unrewritable: [] });
    // A block that does not name the model is left exactly as written.
    expect(r.text).toContain("  - >-\n    dbt run --select stg_customers");
    expect(parseJobFile(r.text)?.commands).toEqual([
      long.replace("orders+", "fct_orders+"),
      "dbt run -s fct_orders",
      other,
    ]);
  });

  it("flow sequences, zero-indent items and CRLF files", () => {
    expect(
      rewriteJobCommands(
        'name: j\ncommands: ["dbt run -s orders", "dbt seed"]\n',
        "orders",
        "x",
      ).text,
    ).toBe('name: j\ncommands: ["dbt run -s x", "dbt seed"]\n');
    const zero =
      'name: j\ncommands:\n- dbt run -s orders  # nightly\n- "dbt test -s orders"\nschedule:\n  cron: "0 * * * *"\n';
    expect(rewriteJobCommands(zero, "orders", "x").text).toBe(
      zero.replaceAll("-s orders", "-s x"),
    );
    const crlf =
      "name: Win\r\ncommands:\r\n  - dbt run --select a orders+ b\r\nenabled: true\r\n";
    expect(rewriteJobCommands(crlf, "orders", "fct_orders")).toMatchObject({
      text: crlf.replace("orders+", "fct_orders+"),
      count: 1,
    });
  });
});

describe("dbt_project.yml", () => {
  const PROJECT = [
    "name: analytics",
    "models:",
    "  analytics:",
    "    +materialized: view",
    "    marts:",
    "      +schema: marts",
    "      orders:",
    "        +materialized: table",
    "      orders_archive:",
    "        +enabled: false",
    "    customers:",
    "      customers:",
    "        +tags: [x]",
    "    inline: {+materialized: table}",
    "seeds:",
    "  analytics:",
    "    orders:",
    "      +enabled: true",
    "",
  ].join("\n");

  it("renames the key whose path is the model's path; folders and other blocks are kept", () => {
    const rename = (path: string, to: string) =>
      rewriteProjectModelConfig(PROJECT, path, to);
    expect(rename("models/marts/orders.sql", "fct_orders")).toEqual({
      text: PROJECT.replace("      orders:\n", "      fct_orders:\n"),
      count: 1,
    });
    // Another folder, the project level and a folder key are not this model.
    expect(rename("models/orders.sql", "x").count).toBe(0);
    expect(rename("models/analytics.sql", "x").count).toBe(0);
    expect(rename("seeds/orders.csv", "x").text).toBe(
      PROJECT.replace("    orders:\n      +enabled", "    x:\n      +enabled"),
    );
    expect(rename("models/customers/customers.sql", "dim").text).toBe(
      PROJECT.replace("      customers:\n", "      dim:\n"),
    );
    expect(rename("models/inline.sql", "flat").text).toBe(
      PROJECT.replace("    inline: {", "    flat: {"),
    );
    const crlf = PROJECT.replace(/\n/g, "\r\n");
    expect(
      rewriteProjectModelConfig(crlf, "models/marts/orders.sql", "fct").text,
    ).toBe(crlf.replace("      orders:\r\n", "      fct:\r\n"));
  });

  it("says which folder-level configs stop applying after a move", () => {
    const lost = (from: string, to: string) =>
      projectConfigsLostByMove(PROJECT, from, to);
    expect(lost("models/marts/orders.sql", "models/orders.sql")).toEqual([
      ["marts"],
      ["marts", "orders"],
    ]);
    // Same folder (a rename), or a folder without config: nothing is lost.
    expect(lost("models/marts/orders.sql", "models/marts/fct.sql")).toEqual([]);
    expect(lost("models/a.sql", "models/staging/a.sql")).toEqual([]);
    expect(mentionsName("value: orders+", "orders")).toBe(true);
    expect(mentionsName("value: orders_x", "orders")).toBe(false);
  });
});

describe("a new name YAML would not read as text is quoted", () => {
  const TYPED = [
    "true",
    "False",
    "null",
    "yes",
    "no",
    "on",
    "off",
    "y",
    "~",
    "123",
    "1e3",
    "0x1F",
    "0o17",
    "1_000",
    "1:30",
    "2026-10-06",
    "2026-10-06T12:00:00Z",
    ".5",
    "-1",
    ".inf",
    "<<",
  ];
  const PROPS = [
    "version: 2",
    "models:",
    "  - name: orders",
    "  - name: 'orders'",
    '  - name: "orders"',
    "unit_tests:",
    "  - name: t",
    "    model: orders",
    "",
  ].join("\n");

  it("`name:`, `model:`, a dbt_project.yml key and job selectors read back as that exact string", () => {
    const project =
      "name: analytics\nmodels:\n  analytics:\n    orders:\n      +materialized: table\n";
    const job =
      "name: J\ncommands:\n  - dbt run --select orders+\n  - dbt test -s orders\n";
    for (const name of TYPED) {
      const props = rewriteNodeProperties(PROPS, "orders", name);
      expect(props.count).toBe(4);
      const doc = yaml.load(props.text) as {
        models: Array<{ name: unknown }>;
        unit_tests: Array<{ model: unknown }>;
      };
      expect([name, ...doc.models.map(m => m.name)]).toEqual([
        name,
        name,
        name,
        name,
      ]);
      expect(doc.unit_tests[0].model).toBe(name);
      expect(renamedScalarsAreStrings(PROPS, props.text, name, 4)).toBe(true);

      // A mapping key is checked the same way as a value: quoted, so it is
      // the string for a YAML 1.1 reader (dbt) too.
      const cfg = rewriteProjectModelConfig(project, "models/orders.sql", name);
      expect(cfg.text).toMatch(/\n {4}(['"]).+\1:\n/);
      expect(renamedScalarsAreStrings(project, cfg.text, name, 1)).toBe(true);
      expect(
        Object.keys(
          (yaml.load(cfg.text) as { models: { analytics: object } }).models
            .analytics,
        ),
      ).toEqual([name]);
      const commands = (
        yaml.load(rewriteJobCommands(job, "orders", name).text) as {
          commands: unknown[];
        }
      ).commands;
      expect(commands).toEqual([
        `dbt run --select ${name}+`,
        `dbt test -s ${name}`,
      ]);
    }
    // A plain name stays bare.
    expect(rewriteNodeProperties(PROPS, "orders", "fct").text).toContain(
      "  - name: fct\n",
    );
  });

  it("the read-back check refuses what quoting prevents, in a value and in a key", () => {
    const bare = PROPS.replace("  - name: orders\n", "  - name: true\n");
    expect(renamedScalarsAreStrings(PROPS, bare, "true", 1)).toBe(false);
    // `yes` is text to a YAML 1.2 reader and a boolean to dbt's.
    const yes = PROPS.replace("  - name: orders\n", "  - name: yes\n");
    expect(renamedScalarsAreStrings(PROPS, yes, "yes", 1)).toBe(false);
    const key = "models:\n  analytics:\n    orders:\n      +tags: [x]\n";
    expect(
      renamedScalarsAreStrings(key, key.replace("orders:", "123:"), "123", 1),
    ).toBe(false);
    expect(
      renamedScalarsAreStrings(key, key.replace("orders:", "'123':"), "123", 1),
    ).toBe(true);
    expect(renamedScalarsAreStrings(PROPS, "models: [", "x", 1)).toBe(false);
  });
});

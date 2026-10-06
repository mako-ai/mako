/**
 * Renaming a model rewrites `ref()`s and job selectors — and nothing else.
 */
import { describe, expect, it } from "vitest";
import {
  mentionsName,
  refNameForDbtPath,
  rewriteJobCommands,
  rewriteNodeProperties,
  rewriteProjectModelConfig,
  rewriteRefs,
  rewriteSelectors,
  selectorsStillNaming,
} from "./dbt-ref-rewrite";

describe("refNameForDbtPath", () => {
  it("names SQL/Python models and seeds; snapshots are named by their block, not the file", () => {
    expect(refNameForDbtPath("models/marts/orders.sql")).toBe("orders");
    expect(refNameForDbtPath("models/ml/churn.py")).toBe("churn");
    expect(refNameForDbtPath("seeds/countries.csv")).toBe("countries");
    expect(refNameForDbtPath("snapshots/orders.sql")).toBeNull();
    expect(refNameForDbtPath("models/schema.yml")).toBeNull();
    expect(refNameForDbtPath("macros/orders.sql")).toBeNull();
    expect(refNameForDbtPath("dbt_project.yml")).toBeNull();
  });
});

describe("rewriteRefs", () => {
  it("rewrites single- and double-quoted refs with any inner whitespace", () => {
    const sql = [
      "select * from {{ ref('orders') }}",
      'join {{ ref("orders") }} using (id)',
      "left join {{ ref( 'orders' ) }} o on 1=1",
      "-- {{ref('orders')}} in a comment is stale too",
    ].join("\n");
    const r = rewriteRefs(sql, "orders", "fct_orders");
    expect(r.count).toBe(4);
    expect(r.text).toBe(
      [
        "select * from {{ ref('fct_orders') }}",
        'join {{ ref("fct_orders") }} using (id)',
        "left join {{ ref( 'fct_orders' ) }} o on 1=1",
        "-- {{ref('fct_orders')}} in a comment is stale too",
      ].join("\n"),
    );
  });

  it("rewrites the version kwarg forms", () => {
    const r = rewriteRefs(
      "{{ ref('orders', v=2) }} {{ ref('orders', version=1) }}",
      "orders",
      "fct_orders",
    );
    expect(r.count).toBe(2);
    expect(r.text).toBe(
      "{{ ref('fct_orders', v=2) }} {{ ref('fct_orders', version=1) }}",
    );
  });

  it("rewrites the two-arg form only when the package is this project", () => {
    const sql =
      "{{ ref('analytics', 'orders') }} {{ ref('other_pkg', 'orders') }} {{ ref(\"analytics\", \"orders\") }}";
    const r = rewriteRefs(sql, "orders", "fct_orders", "analytics");
    expect(r.count).toBe(2);
    expect(r.text).toBe(
      "{{ ref('analytics', 'fct_orders') }} {{ ref('other_pkg', 'orders') }} {{ ref(\"analytics\", \"fct_orders\") }}",
    );
    // Without the project name the two-arg form is left alone entirely.
    expect(rewriteRefs(sql, "orders", "fct_orders").count).toBe(0);
  });

  it("leaves other names, sources and plain SQL alone", () => {
    const sql = [
      "{{ ref('orders_suffix') }}",
      "{{ ref('orders2') }}",
      "{{ ref('prefix_orders') }}",
      "{{ source('orders', 'raw') }}",
      "select * from analytics.orders",
      "{{ ref('orders', 'x') }}", // `orders` as a PACKAGE name
    ].join("\n");
    const r = rewriteRefs(sql, "orders", "fct_orders", "analytics");
    expect(r.count).toBe(0);
    expect(r.text).toBe(sql);
  });

  it("escapes regex metacharacters in names", () => {
    const r = rewriteRefs("{{ ref('a.b') }} {{ ref('aXb') }}", "a.b", "c");
    expect(r.count).toBe(1);
    expect(r.text).toBe("{{ ref('c') }} {{ ref('aXb') }}");
  });
});

describe("rewriteSelectors", () => {
  it("rewrites bare names and graph operators after selector flags", () => {
    const cases: Array<[string, string]> = [
      ["dbt run --select orders", "dbt run --select fct_orders"],
      ["dbt run -s orders+", "dbt run -s fct_orders+"],
      ["dbt run --select +orders", "dbt run --select +fct_orders"],
      ["dbt run --select 2+orders+3", "dbt run --select 2+fct_orders+3"],
      ["dbt run --select @orders", "dbt run --select @fct_orders"],
      ["dbt run --select orders,other", "dbt run --select fct_orders,other"],
      ["dbt run --select other orders", "dbt run --select other fct_orders"],
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
        "dbt test -m orders --target prod",
        "dbt test -m fct_orders --target prod",
      ],
    ];
    for (const [input, expected] of cases) {
      const r = rewriteSelectors(input, "orders", "fct_orders");
      expect(r.text, input).toBe(expected);
      expect(r.count, input).toBeGreaterThan(0);
    }
  });

  it("leaves method selectors, other names and non-selector args alone", () => {
    const cases = [
      "dbt run --select tag:orders",
      "dbt run --select fqn:orders",
      "dbt run --select orders_daily",
      "dbt run --select orders2",
      "dbt run --target orders",
      'dbt run --vars \'{"model": "orders"}\'',
      "dbt run --select other --target orders",
      "dbt run",
    ];
    for (const input of cases) {
      const r = rewriteSelectors(input, "orders", "fct_orders");
      expect(r.text, input).toBe(input);
      expect(r.count, input).toBe(0);
    }
  });

  it("preserves spacing byte-for-byte where nothing changed", () => {
    const input = "dbt   run  --select   orders   --full-refresh";
    expect(rewriteSelectors(input, "orders", "fct_orders").text).toBe(
      "dbt   run  --select   fct_orders   --full-refresh",
    );
  });
});

describe("rewriteNodeProperties", () => {
  const SCHEMA = [
    "version: 2",
    "",
    "models:",
    "  - name: orders  # the fact table",
    "    description: Orders.",
    "    columns:",
    "      - name: orders",
    "        tests: [not_null]",
    "      - name: id",
    "  - name: orders_archive",
    "  - name: 'customers'",
    "",
    "seeds:",
    "  - name: orders",
    "",
    "sources:",
    "  - name: orders",
    "    tables:",
    "      - name: orders",
    "",
  ].join("\n");

  it("renames the node's own entry under models/seeds/snapshots and nothing deeper", () => {
    const r = rewriteNodeProperties(SCHEMA, "orders", "fct_orders");
    expect(r.count).toBe(2);
    expect(r.text).toBe(
      [
        "version: 2",
        "",
        "models:",
        "  - name: fct_orders  # the fact table",
        "    description: Orders.",
        "    columns:",
        "      - name: orders",
        "        tests: [not_null]",
        "      - name: id",
        "  - name: orders_archive",
        "  - name: 'customers'",
        "",
        "seeds:",
        "  - name: fct_orders",
        "",
        "sources:",
        "  - name: orders",
        "    tables:",
        "      - name: orders",
        "",
      ].join("\n"),
    );
  });

  it("keeps quotes, and leaves unrelated files byte-identical", () => {
    const quoted = 'models:\n  - name: "customers"\n';
    expect(
      rewriteNodeProperties(quoted, "customers", "dim_customers").text,
    ).toBe('models:\n  - name: "dim_customers"\n');
    const r = rewriteNodeProperties(SCHEMA, "nothing_here", "x");
    expect(r.count).toBe(0);
    expect(r.text).toBe(SCHEMA);
  });
});

describe("rewriteJobCommands (textual — the file is the author's)", () => {
  const JOB = [
    "# nightly build",
    "name: Daily",
    "description: Runs everything, in order.  # unknown to parseJobFile",
    "environment: dev",
    "commands:",
    "  - dbt deps",
    "  - dbt seed",
    "  - dbt run --select orders+  # the fact table first",
    "  - 'dbt test -s customers,orders'",
    '  - "dbt run --select \\"orders tag:x\\""',
    "  - dbt run --select marts.orders",
    "  - dbt run --select staging",
    "  - dbt run --select other",
    "  - dbt run --select more",
    "  - dbt run --select evenmore",
    "  - dbt run --select tag:nightly",
    "  - |",
    "    dbt run --select orders",
    "enabled: true",
    "",
  ].join("\n");

  it("rewrites the command lines only; comments, unknown keys and all 12 commands survive", () => {
    const r = rewriteJobCommands(JOB, "orders", "fct_orders");
    expect(r.count).toBe(2);
    const expected = JOB.replace(
      "  - dbt run --select orders+  # the fact table first",
      "  - dbt run --select fct_orders+  # the fact table first",
    ).replace(
      "'dbt test -s customers,orders'",
      "'dbt test -s customers,fct_orders'",
    );
    expect(r.text).toBe(expected);
    // A quoted scalar with escapes and a block scalar are reported, not guessed.
    expect(r.unrewritable).toEqual([
      '"dbt run --select \\"orders tag:x\\""',
      "|",
    ]);
    expect(r.text.split("\n").filter(l => /^ {2}- /.test(l))).toHaveLength(12);
  });

  it("dotted and method selectors are detected, not rewritten", () => {
    expect(
      selectorsStillNaming("dbt run --select marts.orders", "orders"),
    ).toEqual(["marts.orders"]);
    expect(
      selectorsStillNaming("dbt run --select fqn:orders tag:x", "orders"),
    ).toEqual(["fqn:orders"]);
    expect(selectorsStillNaming("dbt run --target orders", "orders")).toEqual(
      [],
    );
    expect(selectorsStillNaming("dbt run --select orders_x", "orders")).toEqual(
      [],
    );
  });
});

describe("rewriteProjectModelConfig", () => {
  const PROJECT = [
    "name: analytics",
    "models:",
    "  analytics:",
    "    +materialized: view",
    "    marts:",
    "      orders:",
    "        +materialized: table",
    "      orders_archive:",
    "        +enabled: false",
    "seeds:",
    "  analytics:",
    "    orders:",
    "      +enabled: true",
    "",
  ].join("\n");

  it("renames the model's config key under models: and nothing else", () => {
    const r = rewriteProjectModelConfig(PROJECT, "orders", "fct_orders");
    expect(r.count).toBe(1);
    expect(r.text).toBe(
      PROJECT.replace(
        "      orders:\n        +materialized: table",
        "      fct_orders:\n        +materialized: table",
      ),
    );
    // The project-name level is never a model.
    expect(rewriteProjectModelConfig(PROJECT, "analytics", "x").count).toBe(0);
  });

  it("mentionsName is a whole-word check", () => {
    expect(mentionsName("value: orders+", "orders")).toBe(true);
    expect(mentionsName("value: orders_x", "orders")).toBe(false);
  });
});

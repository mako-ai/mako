/**
 * MetricFlow CONTRACT test.
 *
 * The production image installs `dbt-metricflow` into the same venv as
 * dbt-core (see the Dockerfile). This pins what a semantic-layer feature will
 * rely on, against a REAL dbt-core + dbt-duckdb + dbt-metricflow:
 *   1. `dbt parse` writes target/semantic_manifest.json next to manifest.json
 *   2. `mf query --explain` compiles a ratio metric to SQL without running it
 *   3. `mf query` returns the right numbers (ratio of sums, not avg of ratios)
 *
 * Heavy (downloads dbt via `uv`), so it is gated behind RUN_DBT_ENGINE_CONTRACT
 * like the engine and runner contracts — run locally with:
 *   RUN_DBT_ENGINE_CONTRACT=1 pnpm --filter api exec vitest run metricflow.contract
 *
 * Keep the pins in step with the Dockerfile's /opt/dbt venv.
 */

import { spawnSync } from "child_process";
import {
  existsSync,
  mkdtempSync,
  mkdirSync,
  readFileSync,
  writeFileSync,
} from "fs";
import { tmpdir } from "os";
import { join } from "path";
import { beforeAll, describe, expect, it } from "vitest";

const ENABLED = process.env.RUN_DBT_ENGINE_CONTRACT === "1";

const UV_RUN = [
  "run",
  "--quiet",
  "--no-project",
  "--python",
  "3.11",
  "--with",
  "dbt-core==1.12.7",
  "--with",
  "dbt-duckdb==1.11.1",
  "--with",
  "dbt-metricflow==0.15.0",
];

const SEMANTIC_YML = `models:
  - name: metricflow_time_spine
    time_spine:
      standard_granularity_column: date_day
    columns:
      - name: date_day
        granularity: day
semantic_models:
  - name: orders
    model: ref('orders')
    defaults:
      agg_time_dimension: ordered_at
    entities:
      - name: order
        type: primary
        expr: order_id
      - name: customer
        type: foreign
        expr: customer_id
    dimensions:
      - name: ordered_at
        type: time
        type_params:
          time_granularity: day
    measures:
      - name: order_total
        agg: sum
        expr: amount
      - name: order_count
        agg: count
        expr: order_id
metrics:
  - name: revenue
    label: Revenue
    type: simple
    type_params:
      measure: order_total
  - name: orders
    label: Orders
    type: simple
    type_params:
      measure: order_count
  - name: average_order_value
    label: Average order value
    type: ratio
    type_params:
      numerator: revenue
      denominator: orders
`;

describe.skipIf(!ENABLED)(
  "MetricFlow contract (real dbt-core 1.12.7 + dbt-metricflow 0.15.0)",
  () => {
    let dir: string;

    const run = (...args: string[]) => {
      const result = spawnSync("uv", [...UV_RUN, ...args], {
        cwd: dir,
        env: { ...process.env, DBT_PROFILES_DIR: dir },
        encoding: "utf8",
        timeout: 300_000,
      });
      if (result.status !== 0) {
        throw new Error(
          `${args.join(" ")} exited ${result.status}\n${result.stdout}\n${result.stderr}`,
        );
      }
      return result.stdout;
    };

    beforeAll(() => {
      dir = mkdtempSync(join(tmpdir(), "metricflow-contract-"));
      mkdirSync(join(dir, "models"), { recursive: true });
      writeFileSync(
        join(dir, "dbt_project.yml"),
        'name: probe\nprofile: probe\nversion: "1.0"\nconfig-version: 2\nmodel-paths: ["models"]\n',
      );
      writeFileSync(
        join(dir, "profiles.yml"),
        `probe:\n  target: dev\n  outputs:\n    dev:\n      type: duckdb\n      path: ${dir}/probe.duckdb\n      threads: 1\n`,
      );
      writeFileSync(
        join(dir, "models", "orders.sql"),
        "select * from (values (1, 10, 100.0, date '2026-01-01'), " +
          "(2, 11, 50.0, date '2026-01-02'), (3, 10, 25.0, date '2026-01-02')) " +
          "t(order_id, customer_id, amount, ordered_at)\n",
      );
      writeFileSync(
        join(dir, "models", "metricflow_time_spine.sql"),
        "select cast(range as date) as date_day " +
          "from range(date '2025-01-01', date '2027-01-01', interval 1 day)\n",
      );
      writeFileSync(join(dir, "models", "semantic.yml"), SEMANTIC_YML);
    }, 300_000);

    it("writes semantic_manifest.json on parse", () => {
      run("dbt", "parse", "--quiet");
      expect(existsSync(join(dir, "target", "semantic_manifest.json"))).toBe(
        true,
      );
    }, 300_000);

    it("compiles a ratio metric to SQL with --explain", () => {
      const out = run(
        "mf",
        "query",
        "--metrics",
        "average_order_value",
        "--group-by",
        "metric_time__day",
        "--explain",
      );
      expect(out).toMatch(/NULLIF\(orders, 0\)/);
      expect(out).toMatch(/GROUP BY\s+metric_time__day/);
    }, 300_000);

    it("returns ratio-of-sums values once the models are built", () => {
      run("dbt", "build", "--quiet");
      run(
        "mf",
        "query",
        "--metrics",
        "revenue,average_order_value",
        "--group-by",
        "metric_time__day",
        "--order",
        "metric_time__day",
        "--csv",
        join(dir, "out.csv"),
      );
      const rows = readFileSync(join(dir, "out.csv"), "utf8")
        .trim()
        .split("\n")
        .slice(1)
        .map(line => line.split(","));
      // 2026-01-02: two orders, 50 + 25 → revenue 75, AOV 37.5.
      expect(rows).toHaveLength(2);
      expect(Number(rows[0][1])).toBe(100);
      expect(Number(rows[1][1])).toBe(75);
      expect(Number(rows[1][2])).toBe(37.5);
    }, 300_000);
  },
);

/**
 * MetricFlow engine CONTRACT test.
 *
 * Runs engine/metricflow_engine.py — through the same service the tools use —
 * against a REAL metricflow, on the semantic manifest a real dbt-core 1.12.7
 * parse wrote (test-support/semantic-manifest.fixture.json). It pins what the
 * metric tools rely on:
 *   1. the engine needs `metricflow` only: no dbt, no adapter, no warehouse
 *   2. group-bys come back through the project's joins (customer__region)
 *   3. one query compiles to each dialect Mako maps a connection to
 *   4. filters, a metric_time range, an order and a limit reach the SQL
 *   5. an unknown metric is refused with MetricFlow's suggestions
 *
 * Heavy (downloads metricflow via `uv`), so it is gated behind
 * RUN_DBT_ENGINE_CONTRACT like the other real-dbt contracts — run with:
 *   RUN_DBT_ENGINE_CONTRACT=1 pnpm --filter api exec vitest run metricflow-engine.contract
 *
 * Keep the pin in step with DEFAULT_METRICFLOW_VERSION (dbt-bin.ts) and the
 * Dockerfile's dbt-metricflow.
 */
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

const FIXTURE = vi.hoisted(() => ({ body: Buffer.alloc(0) }));

vi.mock("../services/artifact-store.service", () => ({
  getArtifactStore: () => ({
    openReadStream: async () => {
      const { Readable } = await import("node:stream");
      return Readable.from([FIXTURE.body]);
    },
  }),
}));

import { DEFAULT_METRICFLOW_VERSION } from "./dbt-bin";
import {
  MetricflowQueryError,
  clearMetricflowCaches,
  compileMetricQuery,
  describeMetricGroupBys,
} from "./semantic/metricflow.service";

const ENABLED = process.env.RUN_DBT_ENGINE_CONTRACT === "1";
const KEY = "contract/semantic_manifest.json";

describe.skipIf(!ENABLED)(
  `MetricFlow engine contract (real metricflow ${DEFAULT_METRICFLOW_VERSION})`,
  () => {
    let dir: string;
    const previous = {
      cmd: process.env.MF_ENGINE_PYTHON_CMD,
      manifestDir: process.env.MF_MANIFEST_DIR,
    };

    beforeAll(() => {
      FIXTURE.body = readFileSync(
        join(__dirname, "test-support", "semantic-manifest.fixture.json"),
      );
      dir = mkdtempSync(join(tmpdir(), "metricflow-engine-contract-"));
      process.env.MF_MANIFEST_DIR = dir;
      // metricflow alone: no dbt-core, no adapter.
      process.env.MF_ENGINE_PYTHON_CMD = JSON.stringify([
        "uv",
        "run",
        "--quiet",
        "--no-project",
        "--python",
        "3.11",
        "--with",
        `metricflow==${DEFAULT_METRICFLOW_VERSION}`,
        "python",
      ]);
      clearMetricflowCaches();
    });

    afterAll(() => {
      if (previous.cmd === undefined) delete process.env.MF_ENGINE_PYTHON_CMD;
      else process.env.MF_ENGINE_PYTHON_CMD = previous.cmd;
      if (previous.manifestDir === undefined) {
        delete process.env.MF_MANIFEST_DIR;
      } else process.env.MF_MANIFEST_DIR = previous.manifestDir;
      rmSync(dir, { recursive: true, force: true });
    });

    it("lists the group-bys two metrics share, through the joins", async () => {
      const groupBys = await describeMetricGroupBys(KEY, [
        "revenue",
        "revenue_per_customer",
      ]);
      expect(groupBys.dimensions).toEqual(
        expect.arrayContaining([
          { name: "customer__region", type: "categorical" },
          { name: "customer__plan", type: "categorical" },
          expect.objectContaining({
            name: "metric_time__day",
            type: "time",
            base: "metric_time",
            grain: "day",
          }),
        ]),
      );
      expect(groupBys.entities.map(entity => entity.name).sort()).toEqual([
        "customer",
        "order",
      ]);
    }, 300_000);

    it("compiles a ratio metric for each dialect Mako maps to", async () => {
      const query = {
        metrics: ["average_order_value"],
        groupBy: ["metric_time__month"],
      };
      const postgres = await compileMetricQuery(KEY, "postgres", query);
      expect(postgres).toMatch(/DATE_TRUNC\('month', ordered_at\)/);
      expect(postgres).toMatch(/NULLIF\(orders, 0\)/);
      expect(postgres).toMatch(/AS DOUBLE PRECISION/);

      const redshift = await compileMetricQuery(KEY, "redshift", query);
      expect(redshift).toMatch(/DATE_TRUNC\('month', ordered_at\)/);

      const bigquery = await compileMetricQuery(KEY, "bigquery", query);
      expect(bigquery).toMatch(/TIMESTAMP_TRUNC\(ordered_at, month\)/);
      expect(bigquery).toMatch(/AS FLOAT64/);
    }, 300_000);

    it("writes the join, the filters, the range, the order and the limit", async () => {
      const sql = await compileMetricQuery(KEY, "postgres", {
        metrics: ["revenue", "revenue_per_customer"],
        groupBy: ["customer__region", "metric_time__month"],
        where: ["{{ Dimension('customer__plan') }} = 'enterprise'"],
        orderBy: ["-revenue"],
        limit: 5,
        startTime: "2026-01-01",
        endTime: "2026-03-31",
      });
      expect(sql).toMatch(/"probe"\."main"\."customers"/);
      expect(sql).toMatch(/LEFT OUTER JOIN/);
      expect(sql).toMatch(/customer__plan = 'enterprise'/);
      expect(sql).toMatch(/BETWEEN '2026-01-01' AND '2026-03-31'/);
      expect(sql).toMatch(/ORDER BY revenue DESC/);
      expect(sql).toMatch(/LIMIT 5\s*$/);
    }, 300_000);

    it("widens a metric_time range to whole periods of the grain", async () => {
      const sql = await compileMetricQuery(KEY, "postgres", {
        metrics: ["revenue"],
        groupBy: ["metric_time__week"],
        startTime: "2026-01-01",
        endTime: "2026-03-31",
      });
      // 2026-01-01 is a Thursday: the week it belongs to starts on Monday.
      expect(sql).toMatch(/BETWEEN '2025-12-29' AND '2026-04-05'/);
    }, 300_000);

    it("compiles cumulative metrics against the time spine", async () => {
      const sql = await compileMetricQuery(KEY, "postgres", {
        metrics: ["revenue_last_7_days"],
        groupBy: ["metric_time__day"],
      });
      expect(sql).toMatch(/"probe"\."main"\."metricflow_time_spine"/);
    }, 300_000);

    it("refuses an unknown metric with MetricFlow's suggestions", async () => {
      const failure = await compileMetricQuery(KEY, "postgres", {
        metrics: ["revenu"],
      }).catch(error => error as Error);
      expect(failure).toBeInstanceOf(MetricflowQueryError);
      expect((failure as Error).message).toMatch(/Suggestions:/);
      expect((failure as Error).message).toMatch(/'revenue'/);
    }, 300_000);

    it("refuses a group-by no join path reaches, without MetricFlow's call path", async () => {
      const failure = await compileMetricQuery(KEY, "bigquery", {
        metrics: ["revenue"],
        groupBy: ["customer__country"],
      }).catch(error => error as Error);
      expect(failure).toBeInstanceOf(MetricflowQueryError);
      const message = (failure as Error).message;
      expect(message).toMatch(
        /^The given input does not match any of the available group-by-items/,
      );
      expect(message).toMatch(/Suggestions:/);
      expect(message).toMatch(/Query Input:\s+customer__country/);
      expect(message).not.toMatch(/Issue Location|Error #1|Got error/);
    }, 300_000);

    it("reports a bad Jinja filter by its cause, not by three tracebacks", async () => {
      const failure = await compileMetricQuery(KEY, "postgres", {
        metrics: ["revenue"],
        where: ["{{ Dimension('customer__region' }} = 'x'"],
      }).catch(error => error as Error);
      expect(failure).toBeInstanceOf(MetricflowQueryError);
      const message = (failure as Error).message;
      expect(message).toMatch(/^Error parsing where filter:/);
      expect(message).toContain("{{ Dimension('customer__region' }} = 'x'");
      expect(message).toMatch(/TemplateSyntaxError: unexpected '}'/);
      expect(message).not.toMatch(/Traceback|site-packages|File "/);
      expect(message.length).toBeLessThan(400);
    }, 300_000);

    it("keeps a parenthesised filter in the WHERE clause", async () => {
      const sql = await compileMetricQuery(KEY, "postgres", {
        metrics: ["revenue"],
        where: ["({{ Dimension('customer__region') }} = 'ch' or 1=1)"],
      });
      expect(sql).toMatch(/WHERE \(customer__region = 'ch' or 1=1\)/);
    }, 300_000);

    it("drops a timezone offset from the range and names a value that is no date", async () => {
      const sql = await compileMetricQuery(KEY, "postgres", {
        metrics: ["revenue"],
        groupBy: ["metric_time__day"],
        startTime: "2026-01-01T00:00:00+02:00",
        endTime: "2026-03-31T00:00:00Z",
      });
      expect(sql).toMatch(/BETWEEN '2026-01-01' AND '2026-03-31'/);

      const failure = await compileMetricQuery(KEY, "postgres", {
        metrics: ["revenue"],
        startTime: "not-a-date",
      }).catch(error => error as Error);
      expect((failure as Error).message).toMatch(
        /^startTime "not-a-date" is not a date/,
      );

      const reversed = await compileMetricQuery(KEY, "postgres", {
        metrics: ["revenue"],
        startTime: "2026-03-31",
        endTime: "2026-01-01",
      }).catch(error => error as Error);
      expect((reversed as Error).message).toMatch(
        /^startTime \(2026-03-31T00:00:00\) is after endTime/,
      );
    }, 300_000);
  },
);

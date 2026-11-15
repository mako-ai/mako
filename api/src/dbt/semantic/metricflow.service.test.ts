/**
 * The MetricFlow service's side of the engine protocol, against a stand-in
 * engine (a node script that speaks the same one-JSON-in, one-JSON-out
 * protocol as engine/metricflow_engine.py). The real engine is pinned by
 * dbt/metricflow-engine.contract.test.ts.
 *
 * The claims under test:
 *  - the manifest is fetched from the artifact store once per key and handed
 *    to the engine as a local file;
 *  - a refusal from MetricFlow surfaces as MetricflowQueryError with its
 *    message; a crashed engine as a plain error;
 *  - group-by listings are cached per manifest and metric set; SQL is not;
 *  - the engine's environment is the dbt allowlist, never the API's.
 */
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

const stored = vi.hoisted(() => new Map<string, Buffer>());
const reads = vi.hoisted(() => ({ count: 0 }));

vi.mock("../../services/artifact-store.service", () => ({
  getArtifactStore: () => ({
    openReadStream: async (key: string) => {
      const { Readable } = await import("node:stream");
      const body = stored.get(key);
      if (!body) return null;
      reads.count++;
      return Readable.from([body]);
    },
  }),
}));

import {
  MetricflowQueryError,
  clearMetricflowCaches,
  compileMetricQuery,
  describeMetricGroupBys,
  metricflowDialectFor,
} from "./metricflow.service";

/**
 * Stand-in engine: logs each request to CALLS_LOG, prints noise on stdout
 * before the response (the real engine's dependencies do), and answers by
 * what the request asks for.
 */
const FAKE_ENGINE = `
const fs = require("node:fs");
let input = "";
process.stdin.on("data", chunk => (input += chunk));
process.stdin.on("end", () => {
  const req = JSON.parse(input);
  fs.appendFileSync(process.env.TMPDIR + "/calls.log", JSON.stringify({
    ...req,
    manifest: fs.readFileSync(req.manifest_path, "utf8"),
    leaked: process.env.SESSION_SECRET ?? null,
  }) + "\\n");
  if (req.metrics.includes("slow")) {
    setTimeout(() => console.log(JSON.stringify({ ok: true, sql: "late" })), 20000);
    return;
  }
  if (req.metrics.includes("crash")) {
    console.error("Traceback: boom");
    process.exit(3);
  }
  console.log("noise before the response");
  if (req.metrics.includes("nope")) {
    console.log(JSON.stringify({ ok: false, error: "The given input does not exactly match any known metrics." }));
    return;
  }
  if (req.op === "describe") {
    console.log(JSON.stringify({
      ok: true,
      dimensions: [{ name: "metric_time__day", type: "time", base: "metric_time", grain: "day" }],
      entities: [{ name: "customer", type: "foreign" }],
    }));
    return;
  }
  console.log(JSON.stringify({ ok: true, sql: "SELECT 1 /* " + req.dialect + " */" }));
});
`;

let dir: string;
const previousEnv = { ...process.env };

const calls = () =>
  readFileSync(join(dir, "calls.log"), "utf8")
    .split("\n")
    .filter(line => line.trim())
    .map(line => JSON.parse(line) as Record<string, unknown>);

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "metricflow-service-test-"));
  writeFileSync(join(dir, "engine.js"), FAKE_ENGINE);
  process.env.MF_ENGINE_PYTHON_CMD = JSON.stringify([
    process.execPath,
    join(dir, "engine.js"),
  ]);
  process.env.MF_MANIFEST_DIR = join(dir, "manifests");
  // The engine child gets TMPDIR through the dbt env allowlist.
  process.env.TMPDIR = dir;
  process.env.SESSION_SECRET = "must-not-reach-the-engine";
});

afterAll(() => {
  process.env = previousEnv;
  rmSync(dir, { recursive: true, force: true });
});

beforeEach(() => {
  stored.clear();
  stored.set("runs/1/semantic_manifest.json", Buffer.from('{"v":1}'));
  reads.count = 0;
  clearMetricflowCaches();
  writeFileSync(join(dir, "calls.log"), "");
});

describe("metricflowDialectFor", () => {
  it("maps the connection types MetricFlow renders for", () => {
    expect(metricflowDialectFor("postgresql")).toBe("postgres");
    expect(metricflowDialectFor("cloudsql-postgres")).toBe("postgres");
    expect(metricflowDialectFor("redshift")).toBe("redshift");
    expect(metricflowDialectFor("bigquery")).toBe("bigquery");
  });

  it("has no dialect for the others", () => {
    for (const type of ["clickhouse", "mysql", "mssql", "mongodb", "sqlite"]) {
      expect(metricflowDialectFor(type)).toBeUndefined();
    }
  });
});

describe("compileMetricQuery", () => {
  it("hands the engine the stored manifest and the query, and returns its SQL", async () => {
    const sql = await compileMetricQuery(
      "runs/1/semantic_manifest.json",
      "bigquery",
      {
        metrics: ["revenue"],
        groupBy: ["metric_time__month"],
        where: ["{{ Dimension('customer__region') }} = 'EU'"],
        orderBy: ["-metric_time__month"],
        limit: 12,
        startTime: "2026-01-01",
      },
    );
    expect(sql).toBe("SELECT 1 /* bigquery */");
    expect(calls()).toEqual([
      expect.objectContaining({
        op: "compile",
        dialect: "bigquery",
        metrics: ["revenue"],
        group_by: ["metric_time__month"],
        where: ["{{ Dimension('customer__region') }} = 'EU'"],
        order_by: ["-metric_time__month"],
        limit: 12,
        start_time: "2026-01-01",
        end_time: null,
        manifest: '{"v":1}',
      }),
    ]);
  });

  it("downloads a manifest once, however many queries read it", async () => {
    await compileMetricQuery("runs/1/semantic_manifest.json", "postgres", {
      metrics: ["revenue"],
    });
    await compileMetricQuery("runs/1/semantic_manifest.json", "postgres", {
      metrics: ["orders"],
    });
    expect(reads.count).toBe(1);
    // SQL is compiled each time: two engine runs.
    expect(calls()).toHaveLength(2);
  });

  it("raises MetricFlow's refusal as MetricflowQueryError", async () => {
    await expect(
      compileMetricQuery("runs/1/semantic_manifest.json", "postgres", {
        metrics: ["nope"],
      }),
    ).rejects.toThrow(MetricflowQueryError);
    await expect(
      compileMetricQuery("runs/1/semantic_manifest.json", "postgres", {
        metrics: ["nope"],
      }),
    ).rejects.toThrow(/does not exactly match any known metrics/);
  });

  it("raises a crashed engine as an error that is not a query refusal", async () => {
    const failure = await compileMetricQuery(
      "runs/1/semantic_manifest.json",
      "postgres",
      { metrics: ["crash"] },
    ).catch(error => error as Error);
    expect(failure).toBeInstanceOf(Error);
    expect(failure).not.toBeInstanceOf(MetricflowQueryError);
    expect((failure as Error).message).toMatch(/exit 3.*Traceback: boom/);
  });

  it("gives up at the caller's budget, not at the engine's 60s", async () => {
    const started = Date.now();
    await expect(
      compileMetricQuery(
        "runs/1/semantic_manifest.json",
        "postgres",
        { metrics: ["slow"] },
        undefined,
        1000,
      ),
    ).rejects.toThrow(/MetricFlow did not answer within 1s/);
    expect(Date.now() - started).toBeLessThan(10_000);
  });

  it("fails when the manifest is gone from the store", async () => {
    await expect(
      compileMetricQuery("runs/9/semantic_manifest.json", "postgres", {
        metrics: ["revenue"],
      }),
    ).rejects.toThrow(/no longer in the artifact store/);
    expect(calls()).toEqual([]);
  });

  it("never passes the API's environment to the engine", async () => {
    await compileMetricQuery("runs/1/semantic_manifest.json", "postgres", {
      metrics: ["revenue"],
    });
    expect(calls()[0].leaked).toBeNull();
  });
});

describe("describeMetricGroupBys", () => {
  it("returns the dimensions and entities, and asks the engine once per metric set", async () => {
    const first = await describeMetricGroupBys(
      "runs/1/semantic_manifest.json",
      ["revenue", "orders"],
    );
    expect(first).toEqual({
      dimensions: [
        {
          name: "metric_time__day",
          type: "time",
          base: "metric_time",
          grain: "day",
        },
      ],
      entities: [{ name: "customer", type: "foreign" }],
    });
    // Same set in another order: cached.
    await describeMetricGroupBys("runs/1/semantic_manifest.json", [
      "orders",
      "revenue",
    ]);
    expect(calls()).toHaveLength(1);
    // Another manifest version: asked again.
    stored.set("runs/2/semantic_manifest.json", Buffer.from('{"v":2}'));
    await describeMetricGroupBys("runs/2/semantic_manifest.json", [
      "orders",
      "revenue",
    ]);
    expect(calls()).toHaveLength(2);
    expect(calls()[1].manifest).toBe('{"v":2}');
  });

  it("does not remember a refusal", async () => {
    await expect(
      describeMetricGroupBys("runs/1/semantic_manifest.json", ["nope"]),
    ).rejects.toThrow(MetricflowQueryError);
    await expect(
      describeMetricGroupBys("runs/1/semantic_manifest.json", ["nope"]),
    ).rejects.toThrow(MetricflowQueryError);
    expect(calls()).toHaveLength(2);
  });
});

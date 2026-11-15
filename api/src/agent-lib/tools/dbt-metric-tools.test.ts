/**
 * The semantic-layer tools end to end: list_metrics, compile_metric and
 * query_metric against in-memory Mongo (the dbt project, its runs, its
 * warehouse connection) and an in-memory artifact store holding the semantic
 * manifest a real dbt-core 1.12.7 parse wrote. MetricFlow itself (the Python
 * engine) and the warehouse are stand-ins here; the engine is pinned by
 * dbt/metricflow-engine.contract.test.ts.
 *
 * The claims under test:
 *
 *  - the manifest read is the one stored by the project's last PRODUCTION
 *    build; a project without one falls back to its latest run and says so;
 *    a workspace without any says so instead of failing;
 *  - the SQL is compiled for the dialect of the warehouse connection of the
 *    environment that built the manifest, and refused for a warehouse
 *    MetricFlow cannot render for;
 *  - query_metric runs the compiled SQL through the shared SQL executor with
 *    READ access at most, and not at all for a key without query access;
 *  - an unknown metric is refused before anything is compiled, naming the
 *    metrics that exist;
 *  - lookup_term marks a registry term that is also a metric;
 *  - the tools are part of createDbtServerTools (the factory the in-product
 *    agent and the MCP server share).
 */
import { readFileSync } from "node:fs";
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
import mongoose, { Types } from "mongoose";
import { MongoMemoryServer } from "mongodb-memory-server";

const stored = vi.hoisted(() => new Map<string, Buffer>());
const engine = vi.hoisted(() => ({
  describe: vi.fn(),
  compile: vi.fn(),
}));
const executor = vi.hoisted(() => ({ run: vi.fn() }));

vi.mock("../../services/artifact-store.service", () => ({
  getArtifactStore: () => ({
    openReadStream: async (key: string) => {
      const { Readable } = await import("node:stream");
      const body = stored.get(key);
      return body ? Readable.from([body]) : null;
    },
  }),
}));
vi.mock("../../services/realtime.service", () => ({
  publishRealtimeEvent: vi.fn(),
}));
vi.mock("../../dbt/semantic/metricflow.service", async importOriginal => ({
  ...(await importOriginal<
    typeof import("../../dbt/semantic/metricflow.service")
  >()),
  describeMetricGroupBys: engine.describe,
  compileMetricQuery: engine.compile,
}));
vi.mock("./sql-tools", async importOriginal => ({
  ...(await importOriginal<typeof import("./sql-tools")>()),
  executeQueryImpl: executor.run,
}));

import { compileMetricSchema } from "@mako/agent-tools";
import { sqlReadOnlyAccessError } from "../../services/read-only-query.service";
import { createDbtServerTools } from "./dbt-tools";
import { NO_SEMANTIC_MANIFEST, createDbtMetricTools } from "./dbt-metric-tools";
import {
  DatabaseConnection,
  DbtProject,
  DbtRun,
} from "../../database/workspace-schema";
import { MetricflowQueryError } from "../../dbt/semantic/metricflow.service";
import { clearSemanticCatalogCache } from "../../dbt/semantic/semantic-manifest.service";

const SEMANTIC_MANIFEST = readFileSync(
  join(
    __dirname,
    "..",
    "..",
    "dbt",
    "test-support",
    "semantic-manifest.fixture.json",
  ),
);

let mongo: MongoMemoryServer;
const WS = new Types.ObjectId().toString();
const PROD_CONN = new Types.ObjectId();
const DEV_CONN = new Types.ObjectId();
const ANA = new Types.ObjectId().toString();

type Exec<I, O> = (input: I) => Promise<O>;
const run = <O = Record<string, unknown>>(
  tool: { execute?: unknown },
  input: Record<string, unknown>,
): Promise<O> => (tool.execute as Exec<Record<string, unknown>, O>)(input);

async function seedConnection(_id: Types.ObjectId, name: string, type: string) {
  await DatabaseConnection.collection.insertOne({
    _id,
    workspaceId: new Types.ObjectId(WS),
    name,
    type,
  });
}

/**
 * A dbt project with a prod and a dev environment. `prod`: its last prod
 * build stored a semantic manifest. `devRun`: a later dev run stored one.
 */
async function seedProject(
  options: {
    name?: string;
    prod?: boolean;
    prodSemantic?: boolean;
    devRun?: boolean;
    manifest?: Buffer;
  } = {},
) {
  const {
    name = "Analytics",
    prod = true,
    prodSemantic = true,
    devRun = false,
    manifest = SEMANTIC_MANIFEST,
  } = options;
  const project = await DbtProject.create({
    workspaceId: new Types.ObjectId(WS),
    name,
    environments: [
      {
        name: "prod",
        connectionId: PROD_CONN,
        targetSchema: "dbt_prod",
        threads: 4,
      },
      {
        name: "dev",
        connectionId: DEV_CONN,
        targetSchema: "dbt_dev",
        threads: 4,
      },
    ],
    defaultEnvironment: "dev",
    createdBy: "tester",
    ...(prod ? { lastProdManifestKey: `runs/${name}/prod/manifest.json` } : {}),
  });
  if (prod) {
    if (prodSemantic) {
      stored.set(`runs/${name}/prod/semantic_manifest.json`, manifest);
    }
    await DbtRun.collection.insertOne({
      workspaceId: new Types.ObjectId(WS),
      projectId: project._id,
      environment: "prod",
      status: "success",
      createdAt: new Date("2026-11-01T00:00:00Z"),
      artifactKeys: {
        manifest: `runs/${name}/prod/manifest.json`,
        ...(prodSemantic
          ? { semanticManifest: `runs/${name}/prod/semantic_manifest.json` }
          : {}),
      },
    });
  }
  if (devRun) {
    stored.set(`runs/${name}/dev/semantic_manifest.json`, manifest);
    await DbtRun.collection.insertOne({
      workspaceId: new Types.ObjectId(WS),
      projectId: project._id,
      environment: "dev",
      status: "success",
      createdAt: new Date("2026-11-02T00:00:00Z"),
      artifactKeys: {
        manifest: `runs/${name}/dev/manifest.json`,
        semanticManifest: `runs/${name}/dev/semantic_manifest.json`,
      },
    });
  }
  return project;
}

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
}, 120_000);

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(async () => {
  await Promise.all([
    DbtProject.deleteMany({}),
    DbtRun.deleteMany({}),
    DatabaseConnection.deleteMany({}),
  ]);
  stored.clear();
  clearSemanticCatalogCache();
  engine.describe.mockReset();
  engine.compile.mockReset();
  executor.run.mockReset();
  engine.compile.mockResolvedValue("SELECT 1 AS revenue");
  engine.describe.mockResolvedValue({
    dimensions: [
      {
        name: "metric_time__day",
        type: "time",
        base: "metric_time",
        grain: "day",
      },
      { name: "customer__region", type: "categorical" },
    ],
    entities: [{ name: "customer", type: "foreign" }],
  });
  executor.run.mockResolvedValue({
    success: true,
    rowCount: 1,
    table: "| revenue |\n| --- |\n| 175 |",
    sqlDialect: "postgresql",
  });
  await seedConnection(PROD_CONN, "Warehouse", "postgresql");
  await seedConnection(DEV_CONN, "Warehouse (dev)", "postgresql");
});

const tools = createDbtMetricTools(WS, ANA);

describe("wiring", () => {
  it("ships the three tools in the shared dbt tool factory", () => {
    const names = Object.keys(createDbtServerTools(WS, ANA));
    expect(names).toEqual(
      expect.arrayContaining([
        "list_metrics",
        "compile_metric",
        "query_metric",
      ]),
    );
  });
});

describe("list_metrics", () => {
  it("says so when no semantic manifest is stored", async () => {
    expect(await run(tools.list_metrics, {})).toEqual({
      success: true,
      metrics: [],
      message: NO_SEMANTIC_MANIFEST,
    });
    // A project whose runs predate the semantic manifest is the same case.
    await seedProject({ prodSemantic: false });
    const result = await run<{ message: string }>(tools.list_metrics, {});
    expect(result.message).toBe(NO_SEMANTIC_MANIFEST);
  });

  it("lists the metrics of the last production build", async () => {
    await seedProject();
    const result = await run<{
      metrics: Array<Record<string, unknown>>;
      total: number;
    }>(tools.list_metrics, {});
    expect(result).toMatchObject({
      success: true,
      project: "Analytics",
      source: "prod",
      environment: "prod",
      total: 8,
    });
    expect(result).not.toHaveProperty("note");
    expect(result.metrics).toContainEqual({
      name: "average_order_value",
      label: "Average order value",
      type: "ratio",
      description: "Revenue divided by the number of orders.",
    });
    // Listing never starts MetricFlow.
    expect(engine.describe).not.toHaveBeenCalled();
  });

  it("narrows the list with a query, and says when nothing matches", async () => {
    await seedProject();
    const some = await run<{ metrics: Array<{ name: string }> }>(
      tools.list_metrics,
      { query: "customer" },
    );
    // Name, label and description are all searched.
    expect(some.metrics.map(metric => metric.name)).toEqual([
      "active_customers",
      "enterprise_revenue",
      "revenue_per_customer",
    ]);
    const none = await run<{ metrics: unknown[]; message: string }>(
      tools.list_metrics,
      { query: "churn" },
    );
    expect(none.metrics).toEqual([]);
    expect(none.message).toMatch(
      /No metric matches "churn". 8 metrics are defined/,
    );
  });

  it("points to the dbt skill when the project defines no metrics", async () => {
    await seedProject({
      manifest: Buffer.from(
        JSON.stringify({ semantic_models: [], metrics: [], saved_queries: [] }),
      ),
    });
    const result = await run<{ metrics: unknown[]; message: string }>(
      tools.list_metrics,
      {},
    );
    expect(result.metrics).toEqual([]);
    expect(result.message).toMatch(/define no metrics yet/);
    expect(result.message).toMatch(/semantic-layer reference/);
  });

  it("falls back to the latest run when prod stored no semantic manifest", async () => {
    await seedProject({ prodSemantic: false, devRun: true });
    const result = await run<Record<string, unknown>>(tools.list_metrics, {});
    expect(result).toMatchObject({ source: "latest-run", environment: "dev" });
    expect(result.note).toMatch(/latest run \(environment "dev"\)/);
  });

  it("describes metrics with what they can be grouped by", async () => {
    await seedProject();
    const result = await run<Record<string, unknown>>(tools.list_metrics, {
      metrics: ["revenue", "revenue_per_customer"],
    });
    expect(engine.describe).toHaveBeenCalledWith(
      "runs/Analytics/prod/semantic_manifest.json",
      ["revenue", "revenue_per_customer"],
    );
    expect(result).toMatchObject({
      success: true,
      project: "Analytics",
      metrics: [
        {
          name: "revenue",
          label: "Revenue",
          type: "simple",
          description: "Sum of order amounts.",
          measure: "order_total",
        },
        {
          name: "revenue_per_customer",
          type: "derived",
          expr: "revenue / active_customers",
          inputMetrics: ["revenue", "active_customers"],
        },
      ],
      groupBy: {
        dimensions: [
          {
            name: "metric_time__day",
            type: "time",
            base: "metric_time",
            grain: "day",
          },
          { name: "customer__region", type: "categorical" },
        ],
        entities: [{ name: "customer", type: "foreign" }],
      },
    });
    expect(result).not.toHaveProperty("warning");
  });

  it("refuses an unknown metric before starting MetricFlow, naming the ones that exist", async () => {
    await seedProject();
    const result = await run<{ success: boolean; error: string }>(
      tools.list_metrics,
      { metrics: ["revenue", "churn_rate"] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown metric: churn_rate\./);
    expect(result.error).toMatch(/Defined metrics: active_customers, /);
    expect(engine.describe).not.toHaveBeenCalled();
  });
});

describe("compile_metric", () => {
  it("compiles for the dialect of the production warehouse", async () => {
    await seedProject();
    const result = await run(tools.compile_metric, {
      metrics: ["average_order_value"],
      groupBy: ["metric_time__month"],
      where: ["{{ Dimension('customer__region') }} = 'EU'"],
      orderBy: ["-metric_time__month"],
      limit: 12,
      startTime: "2026-01-01",
      endTime: "2026-12-31",
    });
    expect(engine.compile).toHaveBeenCalledWith(
      "runs/Analytics/prod/semantic_manifest.json",
      "postgres",
      {
        metrics: ["average_order_value"],
        groupBy: ["metric_time__month"],
        // Each filter reaches MetricFlow in parentheses, even a single one.
        where: ["({{ Dimension('customer__region') }} = 'EU')"],
        orderBy: ["-metric_time__month"],
        limit: 12,
        startTime: "2026-01-01",
        endTime: "2026-12-31",
      },
      undefined,
    );
    expect(result).toMatchObject({
      success: true,
      project: "Analytics",
      source: "prod",
      environment: "prod",
      metrics: ["average_order_value"],
      connectionId: PROD_CONN.toString(),
      connectionName: "Warehouse",
      sqlDialect: "postgresql",
      sql: "SELECT 1 AS revenue",
    });
    // Compiling never touches the warehouse.
    expect(executor.run).not.toHaveBeenCalled();
  });

  it("uses BigQuery's dialect on a BigQuery warehouse", async () => {
    await DatabaseConnection.collection.updateOne(
      { _id: PROD_CONN },
      { $set: { type: "bigquery" } },
    );
    await seedProject();
    await run(tools.compile_metric, { metrics: ["revenue"] });
    expect(engine.compile.mock.calls[0][1]).toBe("bigquery");
  });

  it("compiles a latest-run manifest for the environment that built it", async () => {
    await seedProject({ prod: false, devRun: true });
    const result = await run(tools.compile_metric, { metrics: ["revenue"] });
    expect(result).toMatchObject({
      success: true,
      source: "latest-run",
      environment: "dev",
      connectionId: DEV_CONN.toString(),
      connectionName: "Warehouse (dev)",
    });
  });

  it("refuses a warehouse MetricFlow cannot render for", async () => {
    await DatabaseConnection.collection.updateOne(
      { _id: PROD_CONN },
      { $set: { type: "clickhouse" } },
    );
    await seedProject();
    const result = await run<{ success: boolean; error: string }>(
      tools.compile_metric,
      { metrics: ["revenue"] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(
      /MetricFlow cannot write SQL for a clickhouse connection \("Warehouse"\)/,
    );
    expect(result.error).toMatch(
      /postgresql, cloudsql-postgres, redshift, bigquery/,
    );
    expect(engine.compile).not.toHaveBeenCalled();
  });

  it("refuses an unknown metric without compiling", async () => {
    await seedProject();
    const result = await run<{ success: boolean; error: string }>(
      tools.compile_metric,
      { metrics: ["mrr"] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/Unknown metric: mrr\. Defined metrics: /);
    expect(engine.compile).not.toHaveBeenCalled();
  });

  it("passes on MetricFlow's refusal of a query", async () => {
    await seedProject();
    engine.compile.mockRejectedValue(
      new MetricflowQueryError(
        "The given input does not match any of the available group-by-items",
      ),
    );
    const result = await run(tools.compile_metric, {
      metrics: ["revenue"],
      groupBy: ["customer__country"],
    });
    expect(result).toEqual({
      success: false,
      error:
        "The given input does not match any of the available group-by-items",
    });
  });

  it("refuses compiled SQL that is not read-only, as query_metric does", async () => {
    await seedProject();
    engine.compile.mockResolvedValue(
      "SELECT SUM(revenue) AS revenue FROM t WHERE (1=1; drop table x)",
    );
    const input = { metrics: ["revenue"], where: ["1=1; drop table x"] };
    const compiled = await run<Record<string, unknown>>(
      tools.compile_metric,
      input,
    );
    expect(compiled.success).toBe(false);
    expect(compiled.error).toBe(
      sqlReadOnlyAccessError(
        "SELECT SUM(revenue) AS revenue FROM t WHERE (1=1; drop table x)",
        "postgresql",
      ),
    );
    expect(compiled.error).toMatch(/Mako MCP access is read-only/);
    // The statement is not handed back.
    expect(compiled).not.toHaveProperty("sql");
    expect(JSON.stringify(compiled)).not.toMatch(/drop table/);

    const queried = await run<Record<string, unknown>>(
      tools.query_metric,
      input,
    );
    expect(queried.error).toBe(compiled.error);
    expect(executor.run).not.toHaveBeenCalled();
  });

  it("refuses a range that ends before it starts, before compiling", async () => {
    await seedProject();
    const result = await run(tools.compile_metric, {
      metrics: ["revenue"],
      startTime: "2026-03-31",
      endTime: "2026-01-01T00:00:00",
    });
    expect(result).toEqual({
      success: false,
      error:
        "startTime (2026-03-31) is after endTime (2026-01-01T00:00:00): the range holds no rows. Swap them.",
    });
    expect(engine.compile).not.toHaveBeenCalled();
  });

  it("takes dates and naive datetimes only for the range", () => {
    for (const startTime of [
      "2026-01-01",
      "2026-01-01T00:00:00",
      "2026-01-01 08:30",
      "2026-01-01T08:30:15.250",
    ]) {
      expect(
        compileMetricSchema.safeParse({ metrics: ["revenue"], startTime })
          .success,
      ).toBe(true);
    }
    for (const endTime of [
      "2026-01-01T00:00:00+02:00",
      "2026-01-01T00:00:00Z",
      "not-a-date",
      "01/02/2026",
    ]) {
      const parsed = compileMetricSchema.safeParse({
        metrics: ["revenue"],
        endTime,
      });
      expect(parsed.success).toBe(false);
      expect(parsed.error?.issues[0].message).toMatch(
        /endTime must be a date \("2026-01-01"\) or a datetime without a timezone/,
      );
    }
  });

  it("says so when the workspace has no semantic manifest", async () => {
    const result = await run(tools.compile_metric, { metrics: ["revenue"] });
    expect(result).toEqual({ success: false, error: NO_SEMANTIC_MANIFEST });
  });

  it("asks for a projectId when two projects define the metric", async () => {
    const first = await seedProject({ name: "Analytics" });
    const second = await seedProject({ name: "Finance" });
    const ambiguous = await run<{ success: boolean; error: string }>(
      tools.compile_metric,
      { metrics: ["revenue"] },
    );
    expect(ambiguous.success).toBe(false);
    expect(ambiguous.error).toMatch(/defined in several dbt projects/);
    expect(ambiguous.error).toContain(first._id.toString());
    expect(ambiguous.error).toContain(second._id.toString());

    const chosen = await run(tools.compile_metric, {
      metrics: ["revenue"],
      projectId: second._id.toString(),
    });
    expect(chosen).toMatchObject({ success: true, project: "Finance" });
    expect(engine.compile.mock.calls[0][0]).toBe(
      "runs/Finance/prod/semantic_manifest.json",
    );
  });
});

describe("a named dbt environment", () => {
  /** A metric that exists on a dev branch only. */
  const DEV_MANIFEST = Buffer.from(
    JSON.stringify({
      semantic_models: [],
      metrics: [
        { name: "churn_rate", label: "Churn rate", type: "ratio" },
        { name: "revenue", label: "Revenue", type: "simple" },
      ],
    }),
  );

  /** Prod built the fixture; a later dev run stored DEV_MANIFEST. */
  async function seedProdAndDev() {
    const project = await seedProject();
    stored.set("runs/Analytics/dev/semantic_manifest.json", DEV_MANIFEST);
    await DbtRun.collection.insertOne({
      workspaceId: new Types.ObjectId(WS),
      projectId: project._id,
      environment: "dev",
      status: "success",
      createdAt: new Date("2026-11-03T00:00:00Z"),
      artifactKeys: {
        semanticManifest: "runs/Analytics/dev/semantic_manifest.json",
      },
    });
    return project;
  }

  it("keeps production as the default while a dev run holds other metrics", async () => {
    await seedProdAndDev();
    const prod = await run<{ metrics: Array<{ name: string }> }>(
      tools.list_metrics,
      {},
    );
    expect(prod).toMatchObject({ source: "prod", environment: "prod" });
    expect(prod.metrics.map(metric => metric.name)).not.toContain("churn_rate");
  });

  it("lists the metrics of the environment's latest run", async () => {
    await seedProdAndDev();
    const dev = await run<{
      metrics: Array<{ name: string }>;
      note: string;
    }>(tools.list_metrics, { environment: "dev" });
    expect(dev).toMatchObject({
      success: true,
      source: "environment",
      environment: "dev",
    });
    expect(dev.metrics.map(metric => metric.name)).toEqual([
      "churn_rate",
      "revenue",
    ]);
    expect(dev.note).toMatch(/environment "dev", not from production/);
  });

  it("compiles and runs against that environment's manifest and connection", async () => {
    await seedProdAndDev();
    const compiled = await run(tools.compile_metric, {
      metrics: ["churn_rate"],
      environment: "dev",
    });
    expect(compiled).toMatchObject({
      success: true,
      source: "environment",
      environment: "dev",
      connectionId: DEV_CONN.toString(),
      connectionName: "Warehouse (dev)",
    });
    expect(engine.compile.mock.calls[0][0]).toBe(
      "runs/Analytics/dev/semantic_manifest.json",
    );

    await run(tools.query_metric, {
      metrics: ["churn_rate"],
      environment: "dev",
    });
    expect(executor.run.mock.calls[0][0]).toBe(DEV_CONN.toString());

    // The same metric does not exist in production.
    const prod = await run<{ success: boolean; error: string }>(
      tools.compile_metric,
      { metrics: ["churn_rate"] },
    );
    expect(prod.success).toBe(false);
    expect(prod.error).toMatch(/Unknown metric: churn_rate/);
  });

  it("says so when the environment has no run with a manifest", async () => {
    await seedProdAndDev();
    const listed = await run<{ metrics: unknown[]; message: string }>(
      tools.list_metrics,
      { environment: "joan" },
    );
    expect(listed.metrics).toEqual([]);
    expect(listed.message).toMatch(
      /No run of the dbt environment "joan" has stored a semantic manifest/,
    );
    const compiled = await run<{ success: boolean; error: string }>(
      tools.compile_metric,
      { metrics: ["revenue"], environment: "joan" },
    );
    expect(compiled.success).toBe(false);
    expect(compiled.error).toMatch(/dbt environment "joan"/);
    expect(engine.compile).not.toHaveBeenCalled();
  });
});

describe("query_metric", () => {
  it("runs the compiled SQL read-only on the production connection", async () => {
    await seedProject();
    const writer = createDbtMetricTools(WS, ANA, { queryAccess: "write" });
    const result = await run(writer.query_metric, {
      metrics: ["revenue"],
      groupBy: ["customer__region"],
      maxRows: 20,
    });
    expect(executor.run).toHaveBeenCalledTimes(1);
    expect(executor.run).toHaveBeenCalledWith(
      PROD_CONN.toString(),
      undefined,
      "SELECT 1 AS revenue",
      WS,
      ANA,
      undefined,
      // Whatever the caller holds, a metric query runs with read access.
      "read",
      20,
    );
    expect(result).toMatchObject({
      success: true,
      rowCount: 1,
      table: "| revenue |\n| --- |\n| 175 |",
      project: "Analytics",
      source: "prod",
      metrics: ["revenue"],
      connectionId: PROD_CONN.toString(),
      sql: "SELECT 1 AS revenue",
    });
  });

  it("refuses a key without query access, before compiling", async () => {
    await seedProject();
    const noQuery = createDbtMetricTools(WS, ANA, { queryAccess: "none" });
    const result = await run<{ success: boolean; error: string }>(
      noQuery.query_metric,
      { metrics: ["revenue"] },
    );
    expect(result.success).toBe(false);
    expect(result.error).toMatch(/does not have query access/);
    expect(engine.compile).not.toHaveBeenCalled();
    expect(executor.run).not.toHaveBeenCalled();
  });

  it("returns the SQL with the warehouse's error", async () => {
    await seedProject();
    executor.run.mockRejectedValue(
      new Error('relation "orders" does not exist'),
    );
    const result = await run(tools.query_metric, { metrics: ["revenue"] });
    expect(result).toEqual({
      success: false,
      error: 'relation "orders" does not exist',
      sql: "SELECT 1 AS revenue",
    });
  });

  it("does not run anything when the metric does not compile", async () => {
    await seedProject();
    engine.compile.mockRejectedValue(new MetricflowQueryError("no join path"));
    const result = await run(tools.query_metric, { metrics: ["revenue"] });
    expect(result).toEqual({ success: false, error: "no join path" });
    expect(executor.run).not.toHaveBeenCalled();
  });
});

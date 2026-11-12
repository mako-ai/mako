/**
 * Orphan relations: what the warehouse holds that the manifest does not own.
 *
 * The list feeds a human decision to drop tables, so the tests pin both
 * halves: what counts as owned (alias over name, custom schemas, seeds,
 * snapshots, no ephemeral models) and every known way a live relation looks
 * like an orphan (another tool, a CI or branch build, a failed run, an old
 * manifest, test audit tables). No warehouse, no database.
 */
import { describe, expect, it } from "vitest";
import type { DatabaseDriver, WarehouseRelation } from "../databases/driver";
import { BigQueryDatabaseDriver } from "../databases/drivers/bigquery/driver";
import { PostgreSQLDatabaseDriver } from "../databases/drivers/postgresql/driver";
import { makeFakeConnection } from "../databases/test-support/fake-connection";
import {
  DBT_ORPHANS_STALE_HOURS,
  dbtExpectedRelations,
  findDbtOrphans,
  listDbtOrphans,
  type DbtManifestLike,
  type DbtOrphansDeps,
  type DbtOtherRun,
} from "./dbt-orphans.service";

const GENERATED_AT = "2026-06-10T06:00:00Z";
const NOW = new Date("2026-06-11T06:00:00Z");
const BEFORE = new Date("2026-06-01T00:00:00Z");
const AFTER = new Date("2026-06-10T18:00:00Z");

const manifest: DbtManifestLike = {
  metadata: { generated_at: GENERATED_AT },
  nodes: {
    "model.shop.orders": {
      resource_type: "model",
      database: "fake-project",
      schema: "analytics",
      name: "orders",
      alias: "orders",
      config: { materialized: "table" },
    },
    // Alias differs from the model name: the alias is the relation.
    "model.shop.stg_customers": {
      resource_type: "model",
      database: "fake-project",
      schema: "analytics",
      name: "stg_customers",
      alias: "customers",
      config: { materialized: "view" },
    },
    // A custom schema: it is scanned too.
    "model.shop.revenue": {
      resource_type: "model",
      database: "fake-project",
      schema: "analytics_finance",
      name: "revenue",
      config: { materialized: "incremental" },
    },
    // Ephemeral: no relation, and its schema alone is never scanned.
    "model.shop.helper": {
      resource_type: "model",
      database: "fake-project",
      schema: "analytics_scratch",
      name: "helper",
      config: { materialized: "ephemeral" },
    },
    "seed.shop.countries": {
      resource_type: "seed",
      database: "fake-project",
      schema: "analytics",
      name: "countries",
    },
    "snapshot.shop.orders_history": {
      resource_type: "snapshot",
      database: "fake-project",
      schema: "snapshots",
      name: "orders_history",
    },
    // A test that stores failures writes a table named after the test.
    "test.shop.not_null_orders_id": {
      resource_type: "test",
      database: "fake-project",
      schema: "analytics",
      name: "not_null_orders_id",
    },
    // Resource type missing: read from the unique id.
    "model.shop.sessions": {
      database: "fake-project",
      schema: "analytics",
      name: "sessions",
    },
    "analysis.shop.adhoc": {
      resource_type: "analysis",
      database: "fake-project",
      schema: "analytics",
      name: "adhoc",
    },
  },
  sources: {
    "source.shop.raw.payments": {
      database: "fake-project",
      schema: "analytics",
      name: "payments",
      identifier: "raw_payments",
    },
  },
  disabled: {
    "model.shop.legacy_orders": [
      {
        resource_type: "model",
        database: "fake-project",
        schema: "analytics",
        name: "legacy_orders",
      },
    ],
  },
};

function relation(
  name: string,
  extra: Partial<WarehouseRelation> = {},
): WarehouseRelation {
  return {
    database: "fake-project",
    schema: "analytics",
    name,
    type: "table",
    sizeBytes: 1024,
    rowCount: 10,
    lastModified: BEFORE,
    ...extra,
  };
}

function orphansOf(
  relations: WarehouseRelation[],
  extra: {
    otherRuns?: DbtOtherRun[];
    now?: Date;
    manifest?: DbtManifestLike;
  } = {},
) {
  return findDbtOrphans({
    manifest: extra.manifest ?? manifest,
    relations,
    otherRuns: extra.otherRuns,
    now: extra.now ?? NOW,
  });
}

describe("dbtExpectedRelations", () => {
  it("owns models, seeds and snapshots, and scans each of their schemas", () => {
    const sets = dbtExpectedRelations(manifest);
    // orders, customers, revenue, countries, orders_history, sessions.
    expect(sets.expected.size).toBe(6);
    expect(sets.schemas).toEqual([
      { database: "fake-project", schema: "analytics" },
      { database: "fake-project", schema: "analytics_finance" },
      { database: "fake-project", schema: "snapshots" },
    ]);
  });

  it("reads an empty manifest as nothing owned", () => {
    const sets = dbtExpectedRelations({});
    expect(sets.expected.size).toBe(0);
    expect(sets.schemas).toEqual([]);
  });
});

describe("findDbtOrphans: what is owned", () => {
  it("matches by alias, across custom schemas, seeds and snapshots", () => {
    const found = orphansOf([
      relation("orders"),
      relation("customers", { type: "view" }),
      relation("revenue", { schema: "analytics_finance" }),
      relation("countries"),
      relation("orders_history", { schema: "snapshots" }),
      relation("sessions"),
    ]);
    expect(found.orphans).toEqual([]);
    expect(found.expectedCount).toBe(6);
  });

  it("matches names case-insensitively", () => {
    const found = orphansOf([
      relation("ORDERS", { database: "Fake-Project", schema: "Analytics" }),
    ]);
    expect(found.orphans).toEqual([]);
  });

  it("lists the relation named after a model whose alias moved it", () => {
    // The model is `stg_customers`, its relation is `customers`: a table
    // called `stg_customers` is left over from before the alias.
    const found = orphansOf([relation("stg_customers")]);
    expect(found.orphans.map(o => o.name)).toEqual(["stg_customers"]);
  });

  it("does not own the relation of an ephemeral model or an analysis", () => {
    const found = orphansOf([
      relation("helper", { schema: "analytics_scratch" }),
      relation("adhoc"),
    ]);
    expect(found.orphans.map(o => o.name).sort()).toEqual(["adhoc", "helper"]);
  });

  it("keeps the same name in another schema or project apart", () => {
    const found = orphansOf([
      relation("orders", { schema: "analytics_finance" }),
      relation("orders", { database: "other-project" }),
    ]);
    expect(found.orphans).toHaveLength(2);
  });

  it("matches a node without a database in any database", () => {
    const found = orphansOf([relation("events")], {
      manifest: {
        metadata: { generated_at: GENERATED_AT },
        nodes: {
          "model.shop.events": {
            resource_type: "model",
            schema: "analytics",
            name: "events",
          },
        },
      },
    });
    expect(found.orphans).toEqual([]);
  });
});

describe("findDbtOrphans: confidence and false-positive classes", () => {
  it("is high confidence when nothing argues against it", () => {
    const found = orphansOf([relation("old_report", { sizeBytes: 5 })]);
    expect(found.orphans).toEqual([
      {
        database: "fake-project",
        schema: "analytics",
        name: "old_report",
        type: "table",
        sizeBytes: 5,
        rowCount: 10,
        lastModified: BEFORE,
        confidence: "high",
        reasons: [],
      },
    ]);
    expect(found.stale).toBe(false);
    expect(found.manifestAgeHours).toBe(24);
    expect(found.manifestGeneratedAt?.toISOString()).toBe(
      "2026-06-10T06:00:00.000Z",
    );
  });

  it("another tool: a declared source is left out and counted", () => {
    const found = orphansOf([relation("raw_payments")]);
    expect(found.orphans).toEqual([]);
    expect(found.skipped).toEqual({ sources: 1, testFailureTables: 0 });
  });

  it("another tool: a relation written after the manifest is low", () => {
    const [orphan] = orphansOf([
      relation("loader_table", { lastModified: AFTER }),
    ]).orphans;
    expect(orphan.confidence).toBe("low");
    expect(orphan.reasons).toEqual(["written_after_manifest"]);
  });

  it("another tool: an external table is low", () => {
    const [orphan] = orphansOf([
      relation("landing", { type: "external" }),
    ]).orphans;
    expect(orphan.confidence).toBe("low");
    expect(orphan.reasons).toEqual(["external_table"]);
  });

  it("test failures: a stored-failure table of a live test is left out", () => {
    const found = orphansOf([relation("not_null_orders_id")]);
    expect(found.orphans).toEqual([]);
    expect(found.skipped).toEqual({ sources: 0, testFailureTables: 1 });
  });

  it("test failures: anything in an audit schema is low", () => {
    const [orphan] = orphansOf([
      relation("unique_orders_id", { schema: "analytics_dbt_test__audit" }),
    ]).orphans;
    expect(orphan.confidence).toBe("low");
    expect(orphan.reasons).toEqual(["test_audit_schema"]);
  });

  it("CI builds: written while a CI or branch build ran is low", () => {
    const otherRuns: DbtOtherRun[] = [
      {
        kind: "branch",
        startedAt: new Date("2026-05-31T23:00:00Z"),
        completedAt: new Date("2026-06-01T01:00:00Z"),
      },
    ];
    const found = orphansOf(
      [relation("pr_model"), relation("old_report", { lastModified: AFTER })],
      { otherRuns },
    );
    const byName = Object.fromEntries(found.orphans.map(o => [o.name, o]));
    expect(byName.pr_model.confidence).toBe("low");
    expect(byName.pr_model.reasons).toEqual(["written_during_branch_build"]);
    // Outside the build window: not blamed on it.
    expect(byName.old_report.reasons).toEqual(["written_after_manifest"]);
  });

  it("failed run: a model added by a run that then failed is low", () => {
    // The manifest in use is one failed run old: the newer run created the
    // relation, failed, and so never replaced the manifest.
    const otherRuns: DbtOtherRun[] = [
      {
        kind: "failed",
        startedAt: new Date("2026-06-10T17:00:00Z"),
        completedAt: new Date("2026-06-10T19:00:00Z"),
      },
    ];
    const [orphan] = orphansOf(
      [relation("new_model", { lastModified: AFTER })],
      { otherRuns },
    ).orphans;
    expect(orphan.confidence).toBe("low");
    expect(orphan.reasons).toEqual([
      "written_during_failed_run",
      "written_after_manifest",
    ]);
  });

  it("in-flight run: a dbt work table is low", () => {
    const found = orphansOf([
      relation("orders__dbt_tmp"),
      relation("orders__dbt_backup"),
    ]);
    expect(found.orphans.map(o => o.reasons)).toEqual([
      ["dbt_temporary_relation"],
      ["dbt_temporary_relation"],
    ]);
    expect(found.orphans.every(o => o.confidence === "low")).toBe(true);
  });

  it("disabled model: medium, the project still holds it", () => {
    const [orphan] = orphansOf([relation("legacy_orders")]).orphans;
    expect(orphan.confidence).toBe("medium");
    expect(orphan.reasons).toEqual(["disabled_node"]);
  });

  it("no last-write time: medium, the time checks could not run", () => {
    const [orphan] = orphansOf([
      relation("mystery", { lastModified: undefined }),
    ]).orphans;
    expect(orphan.confidence).toBe("medium");
    expect(orphan.reasons).toEqual(["no_last_modified"]);
  });

  it("stale manifest: every orphan is low past the threshold", () => {
    const justInside = new Date(
      Date.parse(GENERATED_AT) + DBT_ORPHANS_STALE_HOURS * 3_600_000,
    );
    const fresh = orphansOf([relation("old_report")], { now: justInside });
    expect(fresh.stale).toBe(false);
    expect(fresh.orphans[0].confidence).toBe("high");

    const justPast = new Date(justInside.getTime() + 3_600_000);
    const stale = orphansOf([relation("old_report")], { now: justPast });
    expect(stale.stale).toBe(true);
    expect(stale.manifestAgeHours).toBe(DBT_ORPHANS_STALE_HOURS + 1);
    expect(stale.orphans[0].confidence).toBe("low");
    expect(stale.orphans[0].reasons).toEqual(["stale_manifest"]);
  });

  it("a manifest with no build date counts as stale", () => {
    const found = orphansOf([relation("old_report")], {
      manifest: { nodes: manifest.nodes },
    });
    expect(found.stale).toBe(true);
    expect(found.manifestAgeHours).toBeUndefined();
    expect(found.orphans[0].reasons).toEqual(["stale_manifest"]);
  });

  it("sorts high confidence first, then the largest relation", () => {
    const found = orphansOf([
      relation("small", { sizeBytes: 1 }),
      relation("recent", { sizeBytes: 999, lastModified: AFTER }),
      relation("large", { sizeBytes: 500 }),
      relation("legacy_orders", { sizeBytes: 900 }),
    ]);
    expect(found.orphans.map(o => o.name)).toEqual([
      "large",
      "small",
      "legacy_orders",
      "recent",
    ]);
  });
});

describe("listDbtOrphans", () => {
  const bigquery = makeFakeConnection("bigquery", {
    project_id: "fake-project",
  });

  function makeDeps(
    overrides: Partial<DbtOrphansDeps> & {
      schemas?: Record<string, WarehouseRelation[] | null>;
      prodLike?: boolean;
    } = {},
  ): DbtOrphansDeps & { listed: string[] } {
    const listed: string[] = [];
    const { schemas, prodLike, ...rest } = overrides;
    const driver = {
      listRelations: async (
        _connection: unknown,
        schema: string,
        options?: { projectId?: string },
      ) => {
        listed.push(`${options?.projectId ?? ""}.${schema}`);
        const known = schemas ?? {
          analytics: [relation("orders"), relation("old_report")],
          analytics_finance: [
            relation("revenue", { schema: "analytics_finance" }),
          ],
          snapshots: null,
        };
        return known[schema] ?? null;
      },
    } as unknown as DatabaseDriver;
    return {
      listed,
      resolveTarget: async params => ({
        connection: bigquery,
        environment: params.environment ?? "prod",
        prodLike: prodLike ?? true,
      }),
      loadManifest: async () => ({
        manifest,
        runId: "64b0c0ffee0123456789abcd",
        otherRuns: [],
      }),
      getDriver: () => driver,
      now: () => NOW,
      ...rest,
    };
  }

  const params = {
    workspaceId: "64b0c0ffee0123456789aaaa",
    projectId: "64b0c0ffee0123456789bbbb",
  };

  it("scans every schema the manifest writes to and reports the rest", async () => {
    const deps = makeDeps();
    const report = await listDbtOrphans(params, deps);
    expect(deps.listed).toEqual([
      "fake-project.analytics",
      "fake-project.analytics_finance",
      "fake-project.snapshots",
    ]);
    expect(report).toEqual({
      supported: true,
      environment: "prod",
      manifestRunId: "64b0c0ffee0123456789abcd",
      manifestGeneratedAt: "2026-06-10T06:00:00.000Z",
      manifestAgeHours: 24,
      stale: false,
      warnings: [
        "A schema that no model writes to any more is not scanned.",
        "Listing only: nothing was dropped. Check low and medium confidence rows by hand before any drop.",
      ],
      schemasScanned: [
        "fake-project.analytics",
        "fake-project.analytics_finance",
      ],
      schemasMissing: ["fake-project.snapshots"],
      expectedCount: 6,
      relationsScanned: 3,
      skipped: { sources: 0, testFailureTables: 0 },
      orphans: [
        {
          ...relation("old_report"),
          confidence: "high",
          reasons: [],
        },
      ],
      truncated: false,
    });
  });

  it("warns on a stale manifest and names its age", async () => {
    const report = await listDbtOrphans(
      params,
      makeDeps({ now: () => new Date("2026-06-30T06:00:00Z") }),
    );
    if (!report.supported) throw new Error("expected a report");
    expect(report.stale).toBe(true);
    expect(report.manifestAgeHours).toBe(480);
    expect(report.warnings[0]).toBe(
      "The manifest is 20 days old (threshold 7 days). Models added since " +
        "then look like orphans. Every orphan is low confidence. Run a job " +
        'in "prod" and list again.',
    );
    expect(report.orphans.map(o => o.confidence)).toEqual(["low"]);
  });

  it("warns when the environment is not production", async () => {
    const report = await listDbtOrphans(
      { ...params, environment: "dev" },
      makeDeps({ prodLike: false }),
    );
    if (!report.supported) throw new Error("expected a report");
    expect(report.environment).toBe("dev");
    expect(report.warnings[0]).toContain(
      '"dev" is not the production environment',
    );
  });

  it("answers unsupported when no manifest is stored yet", async () => {
    const deps = makeDeps({ loadManifest: async () => null });
    expect(await listDbtOrphans(params, deps)).toEqual({
      supported: false,
      reason:
        'Environment "prod" has no stored manifest yet. Run a job in it first.',
    });
    expect(deps.listed).toEqual([]);
  });

  it("answers unsupported on an engine that cannot list relations", async () => {
    const postgres = new PostgreSQLDatabaseDriver() as DatabaseDriver;
    expect(postgres.listRelations).toBeUndefined();
    expect(typeof new BigQueryDatabaseDriver().listRelations).toBe("function");

    let manifestLoads = 0;
    const report = await listDbtOrphans(
      params,
      makeDeps({
        resolveTarget: async () => ({
          connection: makeFakeConnection("postgresql"),
          environment: "prod",
          prodLike: true,
        }),
        getDriver: () => postgres,
        loadManifest: async () => {
          manifestLoads++;
          return null;
        },
      }),
    );
    expect(report).toEqual({
      supported: false,
      reason: "Listing relations is not available on postgresql connections.",
    });
    expect(manifestLoads).toBe(0);
  });

  it("throws when the warehouse listing fails", async () => {
    const failing = {
      listRelations: async () => {
        throw new Error("Could not list relations of fake-project.analytics");
      },
    } as unknown as DatabaseDriver;
    await expect(
      listDbtOrphans(params, makeDeps({ getDriver: () => failing })),
    ).rejects.toThrow("Could not list relations");
  });

  it("caps the list and says so", async () => {
    const many = Array.from({ length: 1001 }, (_, i) =>
      relation(`left_${String(i).padStart(4, "0")}`),
    );
    const report = await listDbtOrphans(
      params,
      makeDeps({
        schemas: { analytics: many, analytics_finance: [], snapshots: [] },
      }),
    );
    if (!report.supported) throw new Error("expected a report");
    expect(report.orphans).toHaveLength(1000);
    expect(report.truncated).toBe(true);
    expect(report.relationsScanned).toBe(1001);
  });
});

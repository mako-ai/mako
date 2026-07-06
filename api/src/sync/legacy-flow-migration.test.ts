import { describe, it, expect } from "vitest";
import {
  planLegacyFlowMigration,
  type MigrationDecision,
  type MigrationFlowInput,
} from "./legacy-flow-migration";

const baseFlow = (
  overrides: Partial<MigrationFlowInput> = {},
): MigrationFlowInput => ({
  _id: "f1",
  type: "scheduled",
  sourceType: "connector",
  syncEngine: "legacy",
  syncMode: "full",
  schedule: { enabled: true, cron: "0 * * * *", timezone: "Europe/Berlin" },
  tableDestination: {
    connectionId: "conn1",
    schema: "public",
    tableName: "crm",
  },
  destinationDatabaseId: "conn1",
  ...overrides,
});

const migrate = (d: MigrationDecision) => {
  expect(d.action).toBe("migrate");
  return d as Extract<MigrationDecision, { action: "migrate" }>;
};

describe("planLegacyFlowMigration — trigger mapping", () => {
  it("full scheduled sync → periodic reconcile, poll disabled (postgresql)", () => {
    const d = migrate(
      planLegacyFlowMigration(baseFlow(), { type: "postgresql" }, null),
    );
    expect(d.updates.syncEngine).toBe("cdc");
    expect(d.updates.backfillSchedule).toEqual({
      enabled: true,
      cron: "0 * * * *",
      timezone: "Europe/Berlin",
    });
    expect(d.updates.schedule).toEqual({
      enabled: false,
      timezone: "Europe/Berlin",
    });
  });

  it("incremental scheduled sync keeps its poll schedule", () => {
    const d = migrate(
      planLegacyFlowMigration(
        baseFlow({ syncMode: "incremental" }),
        { type: "postgresql" },
        null,
      ),
    );
    expect(d.updates.backfillSchedule).toBeUndefined();
    expect(d.updates.schedule).toBeUndefined();
    expect(d.notes.join(" ")).toContain("incremental scheduled sync");
    expect(d.notes.join(" ")).toContain("periodic full reconcile");
  });

  it("incremental flow that already has a reconcile gets no extra recommendation", () => {
    const d = migrate(
      planLegacyFlowMigration(
        baseFlow({
          syncMode: "incremental",
          backfillSchedule: { enabled: true, cron: "0 3 * * *" },
        }),
        { type: "postgresql" },
        null,
      ),
    );
    expect(d.notes.join(" ")).not.toContain("recommendation");
  });

  it("disabled schedule → engine-only migration", () => {
    const d = migrate(
      planLegacyFlowMigration(
        baseFlow({ schedule: { enabled: false, cron: "0 * * * *" } }),
        { type: "postgresql" },
        null,
      ),
    );
    expect(d.updates.schedule).toBeUndefined();
    expect(d.updates.backfillSchedule).toBeUndefined();
    expect(d.notes.join(" ")).toContain("no enabled schedule");
  });
});

describe("planLegacyFlowMigration — per-destination cases", () => {
  it("bigquery forces soft delete via driver capability", () => {
    const d = migrate(
      planLegacyFlowMigration(
        baseFlow({ deleteMode: "hard" }),
        { type: "bigquery", requiresSoftDeleteForCdc: true },
        null,
      ),
    );
    expect(d.updates.deleteMode).toBe("soft");
  });

  it("bigquery flows already on soft delete are not touched", () => {
    const d = migrate(
      planLegacyFlowMigration(
        baseFlow({ deleteMode: "soft" }),
        { type: "bigquery", requiresSoftDeleteForCdc: true },
        null,
      ),
    );
    expect(d.updates.deleteMode).toBeUndefined();
  });

  it("clickhouse migrates with layout-capable tableDestination", () => {
    const d = migrate(
      planLegacyFlowMigration(baseFlow(), { type: "clickhouse" }, null),
    );
    expect(d.updates.syncEngine).toBe("cdc");
  });

  it("postgresql without schema defaults to public", () => {
    const d = migrate(
      planLegacyFlowMigration(
        baseFlow({
          tableDestination: { connectionId: "conn1", tableName: "crm" },
        }),
        { type: "postgresql" },
        null,
      ),
    );
    expect(d.updates.tableDestination?.schema).toBe("public");
    expect(d.updates.tableDestination?.tableName).toBe("crm");
  });

  it("bigquery without dataset is blocked (dataset required)", () => {
    const d = planLegacyFlowMigration(
      baseFlow({
        tableDestination: { connectionId: "conn1", tableName: "crm" },
      }),
      { type: "bigquery", requiresSoftDeleteForCdc: true },
      null,
    );
    expect(d.action).toBe("blocked");
    expect((d as any).reason).toContain("schema/dataset");
  });

  it("mongo collection destination synthesizes tableDestination from source name", () => {
    const d = migrate(
      planLegacyFlowMigration(
        baseFlow({ tableDestination: undefined }),
        { type: "mongodb", databaseName: "analytics" },
        { name: "stripe_prod" },
      ),
    );
    expect(d.updates.tableDestination).toEqual({
      connectionId: "conn1",
      schema: "analytics",
      tableName: "stripe_prod",
      createIfNotExists: true,
    });
    expect(d.notes.join(" ")).toContain("preserves legacy collection names");
  });

  it("mongo destination without database name is blocked", () => {
    const d = planLegacyFlowMigration(
      baseFlow({ tableDestination: undefined }),
      { type: "mongodb" },
      { name: "stripe_prod" },
    );
    expect(d.action).toBe("blocked");
  });

  it("mongo destination without source name is blocked", () => {
    const d = planLegacyFlowMigration(
      baseFlow({ tableDestination: undefined }),
      { type: "mongodb", databaseName: "analytics" },
      null,
    );
    expect(d.action).toBe("blocked");
  });

  it("mysql migrates like postgres (indexes handle layout)", () => {
    const d = migrate(
      planLegacyFlowMigration(baseFlow(), { type: "mysql" }, null),
    );
    expect(d.updates.syncEngine).toBe("cdc");
    expect(d.updates.backfillSchedule?.enabled).toBe(true);
  });

  it("non-CDC destination types are blocked with an explicit reason", () => {
    for (const type of ["redshift", "cloudflare-d1", "cloudflare-kv"]) {
      const d = planLegacyFlowMigration(baseFlow(), { type }, null);
      expect(d.action).toBe("blocked");
      expect((d as any).reason).toContain(`no CDC adapter`);
    }
  });

  it("missing destination is blocked", () => {
    const d = planLegacyFlowMigration(baseFlow(), null, null);
    expect(d.action).toBe("blocked");
  });
});

describe("planLegacyFlowMigration — skips", () => {
  it("skips database-query sources", () => {
    const d = planLegacyFlowMigration(
      baseFlow({ sourceType: "database" }),
      { type: "postgresql" },
      null,
    );
    expect(d.action).toBe("skip");
  });

  it("skips flows already on cdc", () => {
    const d = planLegacyFlowMigration(
      baseFlow({ syncEngine: "cdc" }),
      { type: "postgresql" },
      null,
    );
    expect(d.action).toBe("skip");
  });
});

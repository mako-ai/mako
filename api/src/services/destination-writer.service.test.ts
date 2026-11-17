import { describe, it, expect } from "vitest";
import { DestinationWriter } from "./destination-writer.service";
import { BigQueryDatabaseDriver } from "../databases/drivers/bigquery/driver";
import { PostgreSQLDatabaseDriver } from "../databases/drivers/postgresql/driver";
import { BIGQUERY_WORKING_DATASET } from "../utils/bigquery-working-dataset";
import { makeFakeConnection } from "../databases/test-support";
import type { ColumnDefinition } from "../databases/driver";

/**
 * Unit tests for the engine-agnostic orchestration in DestinationWriter — the
 * code that PR #540 pushed behind driver capabilities. Uses the `_injectForTest`
 * seam to bypass the Mongoose/registry lookup; private methods are reached via
 * a cast since they have no public entry point that avoids real I/O.
 */

interface WriterInternals {
  inferredColumns?: ColumnDefinition[];
  columnTypeMap: Map<string, string> | null;
  applyDestinationColumnTypes(): void;
  getWorkingSchema(primary?: string): string | undefined;
  getTargetSchema(
    primary: string | undefined,
    useWorking: boolean,
  ): string | undefined;
  ensureSchemaForWrite(schema?: string): Promise<void>;
}

function makeWriter(
  driver: BigQueryDatabaseDriver | PostgreSQLDatabaseDriver,
  type: string,
  tableDestination: Record<string, unknown> = {},
): { writer: DestinationWriter; internals: WriterInternals } {
  const writer = new DestinationWriter({
    tableDestination: {
      connectionId: "conn-1",
      tableName: "users",
      schema: "ds",
      ...tableDestination,
    } as never,
  });
  writer._injectForTest(
    driver,
    makeFakeConnection(type, { project_id: "proj" }),
  );
  return { writer, internals: writer as unknown as WriterInternals };
}

describe("DestinationWriter working-schema selection", () => {
  it("BigQuery isolates writes in the working dataset regardless of primary", () => {
    const { internals } = makeWriter(new BigQueryDatabaseDriver(), "bigquery");
    expect(internals.getWorkingSchema("user_ds")).toBe(
      BIGQUERY_WORKING_DATASET,
    );
    expect(internals.getTargetSchema("user_ds", true)).toBe(
      BIGQUERY_WORKING_DATASET,
    );
    // Non-staging writes still go to the primary dataset.
    expect(internals.getTargetSchema("user_ds", false)).toBe("user_ds");
  });

  it("Postgres keeps everything in the primary schema", () => {
    const { internals } = makeWriter(
      new PostgreSQLDatabaseDriver(),
      "postgresql",
    );
    expect(internals.getWorkingSchema("public")).toBe("public");
    expect(internals.getTargetSchema("public", true)).toBe("public");
    expect(internals.getTargetSchema("public", false)).toBe("public");
  });
});

describe("DestinationWriter applyDestinationColumnTypes", () => {
  it("BigQuery remaps source types and builds a lowercased typed column map", () => {
    const { internals } = makeWriter(new BigQueryDatabaseDriver(), "bigquery");
    internals.inferredColumns = [
      { name: "Id", type: "integer", nullable: true },
      { name: "Name", type: "text", nullable: true },
      { name: "Score", type: "double precision", nullable: true },
    ];

    internals.applyDestinationColumnTypes();

    // inferredColumns are remapped to native BigQuery types
    expect(internals.inferredColumns).toEqual([
      { name: "Id", type: "INT64", nullable: true },
      { name: "Name", type: "STRING", nullable: true },
      // "double precision" falls through to STRING (locked-in quirk)
      { name: "Score", type: "STRING", nullable: true },
    ]);
    // typed map keyed by lowercased column name
    expect(internals.columnTypeMap).toEqual(
      new Map([
        ["id", "INT64"],
        ["name", "STRING"],
        ["score", "STRING"],
      ]),
    );
  });

  it("Postgres leaves columns untouched and builds no typed map", () => {
    const { internals } = makeWriter(
      new PostgreSQLDatabaseDriver(),
      "postgresql",
    );
    const cols: ColumnDefinition[] = [
      { name: "id", type: "INTEGER", nullable: true },
      { name: "email", type: "TEXT", nullable: true },
    ];
    internals.inferredColumns = [...cols];

    internals.applyDestinationColumnTypes();

    expect(internals.inferredColumns).toEqual(cols);
    expect(internals.columnTypeMap).toBeNull();
  });
});

describe("DestinationWriter ensureSchemaForWrite", () => {
  function spyEnsureSchema(
    driver: BigQueryDatabaseDriver | PostgreSQLDatabaseDriver,
  ): string[] {
    const ensured: string[] = [];
    (driver as { ensureSchema?: unknown }).ensureSchema = async (
      _conn: unknown,
      schema: string,
    ) => {
      ensured.push(schema);
      return { success: true, created: true };
    };
    return ensured;
  }

  it("BigQuery always ensures its working dataset, even without createIfNotExists", async () => {
    const driver = new BigQueryDatabaseDriver();
    const ensured = spyEnsureSchema(driver);
    const { internals } = makeWriter(driver, "bigquery");
    await internals.ensureSchemaForWrite(BIGQUERY_WORKING_DATASET);
    expect(ensured).toEqual([BIGQUERY_WORKING_DATASET]);
  });

  it("BigQuery skips ensuring the live dataset unless createIfNotExists is set", async () => {
    const driver = new BigQueryDatabaseDriver();
    const ensured = spyEnsureSchema(driver);
    const { internals } = makeWriter(driver, "bigquery"); // createIfNotExists unset
    await internals.ensureSchemaForWrite("ds");
    expect(ensured).toEqual([]);
  });

  it("BigQuery ensures the live dataset when createIfNotExists is set", async () => {
    const driver = new BigQueryDatabaseDriver();
    const ensured = spyEnsureSchema(driver);
    const { internals } = makeWriter(driver, "bigquery", {
      createIfNotExists: true,
    });
    await internals.ensureSchemaForWrite("ds");
    expect(ensured).toEqual(["ds"]);
  });

  it("Postgres only ensures the schema when createIfNotExists is set", async () => {
    const driver = new PostgreSQLDatabaseDriver();
    const ensured = spyEnsureSchema(driver);
    const { internals } = makeWriter(driver, "postgresql");
    await internals.ensureSchemaForWrite("public");
    expect(ensured).toEqual([]);

    const driver2 = new PostgreSQLDatabaseDriver();
    const ensured2 = spyEnsureSchema(driver2);
    const { internals: internals2 } = makeWriter(driver2, "postgresql", {
      createIfNotExists: true,
    });
    await internals2.ensureSchemaForWrite("public");
    expect(ensured2).toEqual(["public"]);
  });
});

/**
 * The nightly ip_intel.crm_asns failure (2026-10-30 → 2026-11-16): the
 * BigQuery swap committed and dropped staging, then the writer's second
 * DROP of the staging name hit "exceeded quota for table update operations".
 * The thrown error failed the Inngest step after the swap, so each retry
 * swapped against a missing staging table until the retries ran out.
 */
describe("DestinationWriter finalize after a committed swap", () => {
  it("does not fail the sync when the post-swap staging drop is rejected", async () => {
    const driver = new BigQueryDatabaseDriver();
    let swaps = 0;
    driver.swapStagingTable = async () => {
      swaps++;
      return { success: true };
    };
    driver.dropTable = async () => ({
      success: false,
      error:
        "Job exceeded rate limits: Your table exceeded quota for table update operations.",
    });
    const { writer } = makeWriter(driver, "bigquery", {
      tableName: "crm_asns",
      schema: "ip_intel",
    });

    writer.markStagingActive();
    await expect(writer.finalize()).resolves.toBeUndefined();
    expect(swaps).toBe(1);
  });

  it("still fails the sync when the swap itself fails", async () => {
    const driver = new BigQueryDatabaseDriver();
    driver.swapStagingTable = async () => ({
      success: false,
      error: "Staging table mako_internal.crm_asns_staging not found",
    });
    const { writer } = makeWriter(driver, "bigquery", {
      tableName: "crm_asns",
      schema: "ip_intel",
    });

    writer.markStagingActive();
    await expect(writer.finalize()).rejects.toThrow(
      "Failed to swap staging table: Staging table mako_internal.crm_asns_staging not found",
    );
  });
});

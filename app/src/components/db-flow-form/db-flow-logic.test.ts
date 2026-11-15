import { describe, expect, it } from "vitest";
import { DEFAULT_FORM_VALUES, type FormData } from "./db-flow-config";
import {
  buildDbFlowPayload,
  dbFlowName,
  validateDbFlow,
} from "./db-flow-logic";
import { cronPresetValue, describeCron } from "../flow-form/schedule-presets";

const form = (over: Partial<FormData> = {}): FormData => ({
  ...DEFAULT_FORM_VALUES,
  databaseSource: { connectionId: "src", database: "", query: " select 1 " },
  tableDestination: {
    ...DEFAULT_FORM_VALUES.tableDestination,
    connectionId: "dst",
    tableName: " events ",
  },
  ...over,
});

describe("validateDbFlow", () => {
  it("requires a query, a table and an incremental tracking column", () => {
    expect(validateDbFlow(form())).toBeNull();
    expect(
      validateDbFlow(
        form({ databaseSource: { connectionId: "s", query: "  " } }),
      ),
    ).toBe("SQL query is required");
    expect(
      validateDbFlow(
        form({
          tableDestination: {
            ...DEFAULT_FORM_VALUES.tableDestination,
            tableName: " ",
          },
        }),
      ),
    ).toBe("Destination table name is required");
    expect(validateDbFlow(form({ syncMode: "incremental" }))).toBe(
      "Tracking column is required for incremental sync",
    );
  });
});

describe("dbFlowName", () => {
  it("names source and destination, with databases when set", () => {
    expect(
      dbFlowName(form(), { id: "src", name: "PG" }, { id: "dst", name: "BQ" }),
    ).toBe("PG → BQ: events ");
    expect(
      dbFlowName(
        form({
          databaseSource: { connectionId: "src", database: "app", query: "q" },
        }),
        { id: "src", name: "PG" },
        undefined,
      ),
    ).toBe("PG/app → Destination: events ");
  });
});

describe("buildDbFlowPayload", () => {
  it("trims, drops empty optionals and omits the schedule when off", () => {
    const payload = buildDbFlowPayload(form(), "n");
    expect(payload).toMatchObject({
      name: "n",
      type: "scheduled",
      sourceType: "database",
      databaseSource: {
        connectionId: "src",
        database: undefined,
        query: "select 1",
      },
      tableDestination: {
        connectionId: "dst",
        database: undefined,
        schema: undefined,
        tableName: "events",
        createIfNotExists: true,
      },
      schedule: { enabled: false, cron: undefined, timezone: undefined },
      syncMode: "full",
      batchSize: 2000,
      paginationConfig: { mode: "offset" },
    });
    expect(payload.incrementalConfig).toBeUndefined();
    expect(payload.conflictConfig).toBeUndefined();
    expect(payload.typeCoercions).toBeUndefined();
  });

  it("adds incremental, conflict, keyset and coercion settings", () => {
    const payload = buildDbFlowPayload(
      form({
        syncMode: "incremental",
        incrementalConfig: {
          trackingColumn: " updated_at ",
          trackingType: "timestamp",
        },
        conflictConfig: { keyColumns: ["id"], strategy: "upsert" },
        paginationConfig: { mode: "keyset", keysetColumn: " id " },
        typeCoercions: [{ column: "a", targetType: "string" }],
        schedule: { enabled: true, cron: "0 * * * *", timezone: "UTC" },
      }),
      "n",
    );
    expect(payload).toMatchObject({
      incrementalConfig: {
        trackingColumn: "updated_at",
        trackingType: "timestamp",
      },
      conflictConfig: { keyColumns: ["id"], strategy: "upsert" },
      paginationConfig: {
        mode: "keyset",
        keysetColumn: "id",
        keysetDirection: "asc",
      },
      typeCoercions: [{ column: "a", targetType: "string" }],
      schedule: { enabled: true, cron: "0 * * * *", timezone: "UTC" },
    });
  });
});

describe("schedule presets", () => {
  it("describes and matches cron expressions", () => {
    expect(describeCron(undefined)).toBe("No schedule selected");
    expect(describeCron("0 * * * *")).toBe("Hourly");
    expect(describeCron("1 2 3 4 5")).toBe("Custom: 1 2 3 4 5");
    expect(cronPresetValue("0 * * * *")).toBe("0 * * * *");
    expect(cronPresetValue("1 2 3 4 5")).toBe("__custom__");
  });
});

import { describe, it, expect } from "vitest";
import { buildOpenTabs } from "./request-context";
import type { ConsoleTab } from "../store/lib/types";

describe("buildOpenTabs", () => {
  it("forwards dbtProjectId for all dbt tab kinds", () => {
    const tabs: ConsoleTab[] = [
      {
        id: "dbt_file_1",
        title: "stg_orders.sql",
        content: "",
        kind: "dbt-file",
        metadata: { projectId: "proj_1", path: "models/stg_orders.sql" },
      },
      {
        id: "dbt_job_1",
        title: "My Job",
        content: "",
        kind: "dbt-job",
        metadata: { projectId: "proj_1" },
      },
      {
        id: "dbt_console_1",
        title: "dbt Console",
        content: "",
        kind: "dbt-console",
        metadata: { projectId: "proj_2" },
      },
      {
        id: "dbt_runs_1",
        title: "dbt Runs",
        content: "",
        kind: "dbt-runs",
        metadata: { projectId: "proj_3" },
      },
      {
        id: "console_1",
        title: "SQL Console",
        content: "select 1",
        kind: "console",
        connectionId: "conn_1",
      },
    ] as any;

    const result = buildOpenTabs(tabs, "dbt_file_1");

    // Verify all dbt tab kinds get dbtProjectId
    expect(result.find(t => t.id === "dbt_file_1")?.dbtProjectId).toBe(
      "proj_1",
    );
    expect(result.find(t => t.id === "dbt_job_1")?.dbtProjectId).toBe("proj_1");
    expect(result.find(t => t.id === "dbt_console_1")?.dbtProjectId).toBe(
      "proj_2",
    );
    expect(result.find(t => t.id === "dbt_runs_1")?.dbtProjectId).toBe(
      "proj_3",
    );

    // Verify non-dbt tab does not get dbtProjectId
    expect(
      result.find(t => t.id === "console_1")?.dbtProjectId,
    ).toBeUndefined();
  });
});

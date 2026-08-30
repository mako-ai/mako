import { describe, expect, it } from "vitest";
import { DASHBOARD_DATA_SOURCE_SEP, tabRevealTarget } from "./explorer-reveal";
import type { ConsoleTab } from "../store/lib/types";

function makeTab(overrides: Partial<ConsoleTab>): ConsoleTab {
  return {
    id: "tab-1",
    title: "Tab",
    content: "",
    isSaved: true,
    ...overrides,
  };
}

describe("tabRevealTarget", () => {
  it("maps consoles to the consoles explorer by tab id", () => {
    expect(tabRevealTarget(makeTab({ id: "c1", kind: "console" }))).toEqual({
      explorer: "consoles",
      nodeId: "c1",
    });
  });

  it("treats an undefined kind as a console", () => {
    expect(tabRevealTarget(makeTab({ id: "c2", kind: undefined }))).toEqual({
      explorer: "consoles",
      nodeId: "c2",
    });
  });

  it("maps dashboards and dashboard data sources to dashboard explorer rows", () => {
    expect(
      tabRevealTarget(
        makeTab({ kind: "dashboard", metadata: { dashboardId: "d1" } }),
      ),
    ).toEqual({ explorer: "dashboards", nodeId: "d1" });
    expect(
      tabRevealTarget(
        makeTab({
          kind: "dashboard-data-source",
          metadata: { dashboardId: "d1", dataSourceId: "ds1" },
        }),
      ),
    ).toEqual({
      explorer: "dashboards",
      nodeId: `d1${DASHBOARD_DATA_SOURCE_SEP}ds1`,
    });
  });

  it("maps connectors by their content id", () => {
    expect(
      tabRevealTarget(makeTab({ kind: "connectors", content: "conn-1" })),
    ).toEqual({ explorer: "connectors", nodeId: "conn-1" });
  });

  it("maps flow editors by flow id", () => {
    expect(
      tabRevealTarget(
        makeTab({ kind: "flow-editor", metadata: { flowId: "f1" } }),
      ),
    ).toEqual({ explorer: "flows", nodeId: "f1" });
  });

  it("returns null for kinds without a stable sidebar row", () => {
    expect(
      tabRevealTarget(
        makeTab({
          kind: "table-data",
          connectionId: "x",
          metadata: { schema: "public", table: "t" },
        }),
      ),
    ).toBeNull();
    expect(tabRevealTarget(makeTab({ kind: "settings" }))).toBeNull();
    expect(tabRevealTarget(makeTab({ kind: "plan" }))).toBeNull();
    expect(tabRevealTarget(null)).toBeNull();
  });

  it("returns null when required metadata is missing", () => {
    expect(
      tabRevealTarget(makeTab({ kind: "dashboard", metadata: {} })),
    ).toBeNull();
  });
});

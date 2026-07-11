import { describe, expect, it } from "vitest";
import {
  APP_BINDING_SEP,
  APP_FILE_SEP,
  APP_V2_FILE_SEP,
  DASHBOARD_DATA_SOURCE_SEP,
  tabRevealTarget,
} from "./explorer-reveal";
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

  it("maps apps, app files and bindings using the shared separators", () => {
    expect(
      tabRevealTarget(makeTab({ kind: "app", metadata: { appId: "a1" } })),
    ).toEqual({ explorer: "apps", nodeId: "a1" });
    expect(
      tabRevealTarget(
        makeTab({
          kind: "app-file",
          metadata: { appId: "a1", path: "src/App.tsx" },
        }),
      ),
    ).toEqual({ explorer: "apps", nodeId: `a1${APP_FILE_SEP}src/App.tsx` });
    expect(
      tabRevealTarget(
        makeTab({
          kind: "app-binding",
          metadata: { appId: "a1", bindingId: "b1" },
        }),
      ),
    ).toEqual({ explorer: "apps", nodeId: `a1${APP_BINDING_SEP}b1` });
  });

  it("maps Apps v2 projects and files to their isolated explorer", () => {
    expect(
      tabRevealTarget(
        makeTab({ kind: "app-v2", metadata: { projectId: "p1" } }),
      ),
    ).toEqual({ explorer: "apps-v2", nodeId: "p1" });
    expect(
      tabRevealTarget(
        makeTab({
          kind: "app-v2-file",
          metadata: { projectId: "p1", path: "src/App.tsx" },
        }),
      ),
    ).toEqual({
      explorer: "apps-v2",
      nodeId: `p1${APP_V2_FILE_SEP}src/App.tsx`,
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
    expect(tabRevealTarget(makeTab({ kind: "app", metadata: {} }))).toBeNull();
    expect(
      tabRevealTarget(makeTab({ kind: "dashboard", metadata: {} })),
    ).toBeNull();
  });
});

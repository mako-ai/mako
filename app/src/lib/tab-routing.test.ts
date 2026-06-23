import { describe, expect, it } from "vitest";
import {
  TAB_DEEP_LINK_PATTERNS,
  decodePathSegments,
  encodePathSegments,
  tabUrlPath,
} from "./tab-routing";
import type { ConsoleTab, TabKind } from "../store/lib/types";

const baseTab = (overrides: Partial<ConsoleTab>): ConsoleTab => ({
  id: "tab-1",
  title: "Tab",
  content: "",
  isSaved: false,
  ...overrides,
});

/**
 * One representative, fully-addressable tab per kind. Being a Record over
 * every TabKind, adding a new kind without a fixture here is a compile
 * error — which forces the round-trip test below to cover it.
 */
const FIXTURES: Record<NonNullable<TabKind>, ConsoleTab> = {
  console: baseTab({ kind: "console" }),
  connectors: baseTab({
    kind: "connectors",
    content: "651234567890abcdef1234",
  }),
  "flow-editor": baseTab({
    kind: "flow-editor",
    metadata: { flowId: "flow-1" },
  }),
  dashboard: baseTab({
    kind: "dashboard",
    metadata: { dashboardId: "dash-1" },
  }),
  "dashboard-data-source": baseTab({
    kind: "dashboard-data-source",
    metadata: { dashboardId: "dash-1", dataSourceId: "ds-1" },
  }),
  "table-data": baseTab({
    kind: "table-data",
    connectionId: "651234567890abcdef1234",
    databaseName: "mydb",
    metadata: { schema: "public", table: "users" },
  }),
  app: baseTab({ kind: "app", metadata: { appId: "app-1" } }),
  "app-file": baseTab({
    kind: "app-file",
    metadata: { appId: "app-1", path: "src/App.tsx" },
  }),
  "app-binding": baseTab({
    kind: "app-binding",
    metadata: { appId: "app-1", bindingId: "binding-1" },
  }),
  plan: baseTab({ kind: "plan", metadata: { chatId: "chat-1" } }),
  settings: baseTab({ kind: "settings", settingsSection: "models" }),
  members: baseTab({ kind: "members" }),
  "dbt-file": baseTab({
    kind: "dbt-file",
    metadata: { projectId: "proj-1", path: "models/stg.sql" },
  }),
  "dbt-job": baseTab({
    kind: "dbt-job",
    metadata: { projectId: "proj-1", jobId: "job-1" },
  }),
  "dbt-console": baseTab({
    kind: "dbt-console",
    metadata: { projectId: "proj-1" },
  }),
  "dbt-runs": baseTab({
    kind: "dbt-runs",
    metadata: { projectId: "proj-1" },
  }),
};

const ALL_KINDS = Object.keys(FIXTURES) as Array<NonNullable<TabKind>>;

describe("tab-routing", () => {
  it.each(ALL_KINDS)(
    "round-trips %s: generated URL is matched by its deep-link pattern",
    kind => {
      const tab = FIXTURES[kind];
      const url = tabUrlPath(tab.id, tab);
      const pattern: RegExp | null = TAB_DEEP_LINK_PATTERNS[kind];

      if (pattern === null) {
        // Kinds without a deep link must not generate a URL either.
        expect(url).toBeNull();
        return;
      }

      expect(url).not.toBeNull();
      const pathname = (url as string).split("?")[0];
      expect(pathname).toMatch(pattern);
    },
  );

  it("keeps nested routes from being captured by their parent patterns", () => {
    // /d/:id/data/:dsId must not be treated as a dashboard URL, and
    // /a/:id/file|data/... must not be treated as an app URL — hydration
    // relies on the parent patterns being anchored.
    const dsUrl = tabUrlPath("t", FIXTURES["dashboard-data-source"]) as string;
    expect(dsUrl).not.toMatch(TAB_DEEP_LINK_PATTERNS.dashboard);

    const fileUrl = tabUrlPath("t", FIXTURES["app-file"]) as string;
    const bindingUrl = tabUrlPath("t", FIXTURES["app-binding"]) as string;
    expect(fileUrl).not.toMatch(TAB_DEEP_LINK_PATTERNS.app);
    expect(bindingUrl).not.toMatch(TAB_DEEP_LINK_PATTERNS.app);

    // /x/:id/file|job|runs must not be captured by the bare console pattern.
    const dbtFileUrl = tabUrlPath("t", FIXTURES["dbt-file"]) as string;
    const dbtJobUrl = tabUrlPath("t", FIXTURES["dbt-job"]) as string;
    const dbtRunsUrl = tabUrlPath("t", FIXTURES["dbt-runs"]) as string;
    expect(dbtFileUrl).not.toMatch(TAB_DEEP_LINK_PATTERNS["dbt-console"]);
    expect(dbtJobUrl).not.toMatch(TAB_DEEP_LINK_PATTERNS["dbt-console"]);
    expect(dbtRunsUrl).not.toMatch(TAB_DEEP_LINK_PATTERNS["dbt-console"]);
  });

  it("encodes nested dbt file paths in their URL", () => {
    const url = tabUrlPath("t", FIXTURES["dbt-file"]) as string;
    expect(url).toBe("/x/proj-1/file/models/stg.sql");
  });

  it("tabs missing their identifiers produce no URL instead of a broken one", () => {
    expect(tabUrlPath("t", baseTab({ kind: "connectors", content: "" }))).toBe(
      null,
    );
    expect(tabUrlPath("t", baseTab({ kind: "flow-editor" }))).toBeNull();
    expect(tabUrlPath("t", baseTab({ kind: "table-data" }))).toBeNull();
    expect(tabUrlPath("t", baseTab({ kind: "app" }))).toBeNull();
  });

  it("encodes and decodes file paths with special characters", () => {
    const path = "src/components/My File #1.tsx";
    expect(decodePathSegments(encodePathSegments(path))).toBe(path);
    expect(encodePathSegments(path)).not.toContain(" ");
    expect(encodePathSegments(path)).not.toContain("#");
  });

  it("includes the database in table URLs as query params", () => {
    const url = tabUrlPath("t", FIXTURES["table-data"]) as string;
    expect(url).toBe("/t/651234567890abcdef1234/public/users?db=mydb");
  });
});

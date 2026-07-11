/**
 * Entity labels: single source of truth for the human noun of each tab kind.
 *
 * Used by the shared entity load/error states ("App not found", "You don't
 * have access to this dashboard", "Loading flow…") so the copy stays
 * consistent everywhere a resource fails to load.
 *
 * REGRESSION GUARD: exhaustive over `TabKind` (same pattern as
 * lib/tab-routing.ts) — adding a tab kind without deciding its label is a
 * compile error.
 */
import type { TabKind } from "../store/lib/types";
import type { LoadError } from "../api/result";

export const TAB_KIND_ENTITY_LABELS = {
  console: "console",
  connectors: "connector",
  "flow-editor": "flow",
  dashboard: "dashboard",
  "dashboard-data-source": "data source",
  "table-data": "table",
  app: "app",
  "app-file": "file",
  "app-binding": "data source",
  "app-v2": "app project",
  "app-v2-file": "file",
  plan: "plan",
  settings: "settings section",
  members: "members page",
  "dbt-file": "file",
  "dbt-job": "job",
  "dbt-runs": "runs view",
  "dbt-console": "project",
} as const satisfies Record<NonNullable<TabKind>, string>;

export function tabKindEntityLabel(kind: TabKind | undefined): string {
  return TAB_KIND_ENTITY_LABELS[kind ?? "console"];
}

/**
 * 404 `LoadError` for a sub-entity missing from a loaded parent (file removed
 * from an app, data source removed from a dashboard, job deleted from a
 * project, ...). Renders with the "not found" treatment in
 * EntityLoadErrorState; pass `detail` there for context-specific copy.
 */
export function missingEntityError(entityLabel: string): LoadError {
  return {
    status: 404,
    message: `${entityLabel.charAt(0).toUpperCase()}${entityLabel.slice(1)} not found`,
  };
}

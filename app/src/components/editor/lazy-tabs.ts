import type { ComponentProps } from "react";
import { lazyWithSuspense } from "../../lib/lazy-component";

// Heavy tab bodies are split out of the entry chunk (xterm, MUI X data
// grid, notebooks, dbt, settings): each loads when its tab first renders.
export const Settings = lazyWithSuspense(() => import("../../pages/Settings"));
export const SourceConnectionTab = lazyWithSuspense(
  () => import("../SourceConnectionTab"),
);
export const NotebookRenderer = lazyWithSuspense(
  () => import("../NotebookRenderer"),
);
export const AppWorkspace = lazyWithSuspense(() => import("../AppWorkspace"));
export const AppFileEditor = lazyWithSuspense(() => import("../AppFileEditor"));
export const AppDiffTab = lazyWithSuspense(() => import("../AppDiffTab"));
export const HistoryDiffTab = lazyWithSuspense(
  () => import("../HistoryDiffTab"),
);
export const RepoDiffTab = lazyWithSuspense(() => import("../RepoDiffTab"));
export const AppBindingEditor = lazyWithSuspense(
  () => import("../AppBindingEditor"),
);
export const PlanDocumentTab = lazyWithSuspense(
  () => import("../PlanDocumentTab"),
);
export const DbtFileEditor = lazyWithSuspense(() => import("../DbtFileEditor"));
export const DbtJobView = lazyWithSuspense(() => import("../DbtJobView"));
export const DbtConsoleView = lazyWithSuspense(
  () => import("../DbtConsoleView"),
);
export const DbtRunsView = lazyWithSuspense(() => import("../DbtRunsView"));
export const AppsHome = lazyWithSuspense(() => import("../apps-home/AppsHome"));
export const WorkflowView = lazyWithSuspense(() => import("../WorkflowView"));
export const TableDataView = lazyWithSuspense(() => import("../TableDataView"));
// The results grid (MUI X DataGridPremium) is only needed once a console
// has results, so it stays out of the initial load too.
export const ResultsTable = lazyWithSuspense(() => import("../ResultsTable"));
export const WorkspaceMembers = lazyWithSuspense<Record<string, never>>(() =>
  import("../WorkspaceMembers").then(m => ({ default: m.WorkspaceMembers })),
);
export const FlowEditor = lazyWithSuspense<
  ComponentProps<(typeof import("../FlowEditor"))["FlowEditor"]>
>(() => import("../FlowEditor").then(m => ({ default: m.FlowEditor })));
export const ShareDialog = lazyWithSuspense(
  () => import("../ShareDialog"),
  null,
);
// Modals that only open on demand (scheduling pulls in cron-parser + luxon).
export const ScheduleConsoleModal = lazyWithSuspense(
  () => import("../ScheduleConsoleModal"),
  null,
);

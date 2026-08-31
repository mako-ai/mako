/**
 * dbt tab-open helpers. Both the explorer and the agent's client tools open
 * tabs through these; dedupe is the store's focusOrOpenTab, like every kind.
 */

import { findTab, useConsoleStore } from "../store/consoleStore";
import { useDbtStore } from "../store/dbtStore";
import { basename } from "../utils/path";

/** Open (or focus) a full-screen editor tab for a single dbt project file. */
export function focusDbtFileTab(projectId: string, path: string): string {
  const tabId = useConsoleStore.getState().focusOrOpenTab(
    { kind: "dbt-file", metadata: { projectId, path } },
    () => ({
      title: basename(path),
      content: "",
      kind: "dbt-file",
      metadata: { projectId, path },
    }),
    // Each file opens its own tab instead of replacing a pristine one.
    { replacePristine: false },
  ) as string;
  useDbtStore.getState().setActiveProject(projectId);
  return tabId;
}

/** Open (or focus) the project Console tab (command bar + problems). */
export function focusDbtConsoleTab(projectId: string, title: string): string {
  const tabId = useConsoleStore.getState().focusOrOpenTab(
    { kind: "dbt-console", metadata: { projectId } },
    () => ({
      title,
      content: "",
      kind: "dbt-console",
      metadata: { projectId },
    }),
    // A project's console is a durable document, not a preview: pinned at
    // open (as notebooks are) so the next open cannot replace it.
    { replacePristine: false, pin: true },
  ) as string;
  useDbtStore.getState().setActiveProject(projectId);
  return tabId;
}

/**
 * Open (or focus) the project-wide Runs tab (run history + live logs for every
 * run, including ad-hoc agent/editor runs that have no jobId). When `runId` is
 * given, the Runs view selects that run on open (used by the chat run card).
 */
export function focusDbtRunsTab(
  projectId: string,
  title: string,
  runId?: string,
): string {
  const consoleStore = useConsoleStore.getState();
  const match = { kind: "dbt-runs" as const, metadata: { projectId } };
  const existed = Boolean(findTab(match)(consoleStore));
  const tabId = consoleStore.focusOrOpenTab(
    match,
    () => ({
      title,
      content: "",
      kind: "dbt-runs",
      metadata: { projectId, focusRunId: runId },
    }),
    { replacePristine: false },
  ) as string;
  // If re-focusing an existing tab with a new target run, update the metadata
  // so DbtRunsView can react and select it. updateMetadata replaces the whole
  // object, so pass the full set.
  if (existed && runId) {
    consoleStore.updateMetadata(tabId, { projectId, focusRunId: runId });
  }
  useDbtStore.getState().setActiveProject(projectId);
  return tabId;
}

/**
 * Open (or focus) the job view tab (run history + edit) for a dbt job. Pass
 * `autoEdit` for a freshly created job so it opens straight into the edit form
 * (mirrors dbt Cloud's "create job" flow).
 */
export function focusDbtJobTab(
  projectId: string,
  jobId: string,
  title: string,
  autoEdit?: boolean,
): string {
  const tabId = useConsoleStore.getState().focusOrOpenTab(
    { kind: "dbt-job", metadata: { projectId, jobId } },
    () => ({
      title,
      content: "",
      kind: "dbt-job",
      metadata: { projectId, jobId, autoEdit },
    }),
    { replacePristine: false },
  ) as string;
  useDbtStore.getState().setActiveProject(projectId);
  return tabId;
}

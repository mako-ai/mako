/**
 * dbt tab-open helpers — clones of app-runtime/shell.ts. Both the explorer
 * and the agent's client tools open tabs through these so dedupe behavior
 * is identical everywhere.
 */

import { useConsoleStore } from "../store/consoleStore";
import { useUIStore } from "../store/uiStore";

export function getCurrentWorkspaceId(): string | null {
  return useUIStore.getState().currentWorkspaceId ?? null;
}

function basename(path: string): string {
  return path.split("/").filter(Boolean).pop() || path;
}

/** Open (or focus) a full-screen editor tab for a single dbt project file. */
export function focusDbtFileTab(projectId: string, path: string): string {
  const consoleStore = useConsoleStore.getState();
  const existingTab = Object.values(consoleStore.tabs).find(
    (tab: {
      kind?: string;
      metadata?: { projectId?: string; path?: string };
    }) =>
      tab.kind === "dbt-file" &&
      tab.metadata?.projectId === projectId &&
      tab.metadata?.path === path,
  );

  const tabId =
    existingTab?.id ??
    consoleStore.openTab(
      {
        title: basename(path),
        content: "",
        kind: "dbt-file",
        metadata: { projectId, path },
      },
      // Each file opens its own tab instead of replacing a pristine one.
      { replacePristine: false },
    );

  consoleStore.setActiveTab(tabId);
  return tabId;
}

/** Open (or focus) the project Console tab (command bar + problems). */
export function focusDbtConsoleTab(projectId: string, title: string): string {
  const consoleStore = useConsoleStore.getState();
  const existingTab = Object.values(consoleStore.tabs).find(
    (tab: { kind?: string; metadata?: { projectId?: string } }) =>
      tab.kind === "dbt-console" && tab.metadata?.projectId === projectId,
  );

  const tabId =
    existingTab?.id ??
    consoleStore.openTab(
      {
        title,
        content: "",
        kind: "dbt-console",
        metadata: { projectId },
      },
      { replacePristine: false },
    );

  consoleStore.setActiveTab(tabId);
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
  const existingTab = Object.values(consoleStore.tabs).find(
    (tab: { kind?: string; metadata?: { projectId?: string } }) =>
      tab.kind === "dbt-runs" && tab.metadata?.projectId === projectId,
  );

  const tabId =
    existingTab?.id ??
    consoleStore.openTab(
      {
        title,
        content: "",
        kind: "dbt-runs",
        metadata: { projectId, focusRunId: runId },
      },
      { replacePristine: false },
    );

  // If re-focusing an existing tab with a new target run, update the metadata
  // so DbtRunsView can react and select it. updateMetadata replaces the whole
  // object, so pass the full set.
  if (existingTab && runId) {
    consoleStore.updateMetadata(tabId, { projectId, focusRunId: runId });
  }

  consoleStore.setActiveTab(tabId);
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
  const consoleStore = useConsoleStore.getState();
  const existingTab = Object.values(consoleStore.tabs).find(
    (tab: {
      kind?: string;
      metadata?: { projectId?: string; jobId?: string };
    }) =>
      tab.kind === "dbt-job" &&
      tab.metadata?.projectId === projectId &&
      tab.metadata?.jobId === jobId,
  );

  const tabId =
    existingTab?.id ??
    consoleStore.openTab(
      {
        title,
        content: "",
        kind: "dbt-job",
        metadata: { projectId, jobId, autoEdit },
      },
      { replacePristine: false },
    );

  consoleStore.setActiveTab(tabId);
  return tabId;
}

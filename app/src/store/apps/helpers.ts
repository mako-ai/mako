/**
 * App URL/identity helpers and the cross-explorer refresh after a repo
 * (dis)connect. Pure or store-independent.
 */
import type { AppMeta } from "./types";

/** Repo-relative folder of an app; legacy rows sit at `apps/<slug>`. */
export function appRootOf(app: Pick<AppMeta, "id" | "slug" | "path">): string {
  return app.path ?? `apps/${app.slug ?? app.id}`;
}

/**
 * What an app's URL uses: its slug when it sits at the top of the workspace
 * tree (`/apps/report`, readable and stable), its id otherwise — a nested
 * folder name may be shared by another app, and an id never is.
 */
export function appUrlRef(app: Pick<AppMeta, "id" | "slug" | "path">): string {
  return app.slug && appRootOf(app) === `apps/${app.slug}` ? app.slug : app.id;
}

/**
 * The `appSlug` a tab should carry: the URL slug when the app has one, else
 * nothing (the tab falls back to the id). Every caller that opens a tab for
 * an app must pass THIS, never `app.slug` — a nested app's folder name is
 * not a URL handle, and a link built from it would not resolve.
 */
export function appUrlSlug(
  app: Pick<AppMeta, "id" | "slug" | "path">,
): string | undefined {
  const ref = appUrlRef(app);
  return ref === app.id ? undefined : ref;
}

/**
 * Does a dev-server entry from the box belong to this app? The box reports
 * the app's id (nested and personal apps have no unique folder name); a box
 * whose agent predates that still reports the folder basename until it
 * restarts, so both are accepted.
 */
export function devServerKeyMatches(
  key: string,
  app: Pick<AppMeta, "id" | "slug">,
): boolean {
  return key === app.id || (!!app.slug && key === app.slug);
}

/**
 * After connect/disconnect the derived git index in Mongo has changed.
 * Explorers keep their last tree until something refetches — a full reload
 * used to be the only way to see an empty workspace after unlink.
 */
export function refreshGitDerivedExplorers(
  workspaceId: string,
  fetchApps: (id: string) => void,
): void {
  void fetchApps(workspaceId);
  void import("../consoleTreeStore").then(({ useConsoleTreeStore }) => {
    void useConsoleTreeStore.getState().fetchTree(workspaceId);
  });
  void import("../notebookTreeStore").then(({ useNotebookTreeStore }) => {
    void useNotebookTreeStore.getState().fetchTree(workspaceId);
  });
  void import("../flowStore").then(({ useFlowStore }) => {
    void useFlowStore.getState().fetchFlows(workspaceId);
  });
  void import("../dbtStore").then(({ useDbtStore }) => {
    void useDbtStore.getState().fetchProjects(workspaceId);
  });
  if (typeof window !== "undefined") {
    window.dispatchEvent(
      new CustomEvent("mako-git-index-changed", { detail: { workspaceId } }),
    );
  }
}

/**
 * Record whether one of an app's reads came back `busy` (the last commit,
 * served because the server had no slot for the live box). Clears the flag
 * on a live answer, and drops the app's entry once no read is busy.
 */
export function setBusyRead(
  busyReadByApp: Record<string, { files?: true; status?: true }>,
  appId: string,
  read: "files" | "status",
  busy: boolean,
): void {
  const entry = busyReadByApp[appId] ?? {};
  if (busy) entry[read] = true;
  else delete entry[read];
  if (entry.files || entry.status) busyReadByApp[appId] = entry;
  else delete busyReadByApp[appId];
}

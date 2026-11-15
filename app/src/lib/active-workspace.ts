/**
 * Boot hint for the workspace this browser tab works in.
 *
 * The active workspace is owned by `useWorkspaceStore` (in memory, per page).
 * This module only persists the last choice so a reload or a new tab can
 * start from it — it is read once, when the store is created (and by the API
 * client before the store has loaded), never as a live source.
 *
 * The hint is kept per tab in sessionStorage (which also survives the
 * post-switch reload), so switching workspace in tab B does not re-point tab
 * A on its next reload. localStorage keeps the last choice only as the default
 * for a tab that has not chosen yet (a new tab, a fresh window).
 */
const KEY = "activeWorkspaceId";

function read(storage: () => Storage): string | null {
  try {
    return storage().getItem(KEY);
  } catch {
    return null;
  }
}

/** This tab's last workspace, else the last workspace chosen in any tab. */
export function getBootWorkspaceId(): string | null {
  return read(() => sessionStorage) ?? read(() => localStorage);
}

export function rememberWorkspaceId(id: string): void {
  try {
    sessionStorage.setItem(KEY, id);
  } catch {
    // storage unavailable
  }
  try {
    localStorage.setItem(KEY, id);
  } catch {
    // storage unavailable
  }
}

export function forgetWorkspaceId(): void {
  try {
    sessionStorage.removeItem(KEY);
  } catch {
    // storage unavailable
  }
  try {
    localStorage.removeItem(KEY);
  } catch {
    // storage unavailable
  }
}

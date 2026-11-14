/**
 * The workspace this browser tab is working in.
 *
 * It used to live only in localStorage, which every tab of the origin shares:
 * switching workspace in tab B silently re-pointed tab A's requests
 * (`x-workspace-id`) and froze tab A's console-tab persistence. The id is now
 * kept per tab in sessionStorage (which also survives the post-switch
 * reload). localStorage keeps the last choice only as the default for a tab
 * that has not chosen yet (a new tab, a fresh window).
 */
const KEY = "activeWorkspaceId";

function read(storage: () => Storage): string | null {
  try {
    return storage().getItem(KEY);
  } catch {
    return null;
  }
}

/** This tab's own choice, without falling back to the shared default. */
export function getTabWorkspaceId(): string | null {
  return read(() => sessionStorage);
}

/** This tab's workspace, else the last workspace chosen in any tab. */
export function getActiveWorkspaceId(): string | null {
  return getTabWorkspaceId() ?? read(() => localStorage);
}

export function setActiveWorkspaceId(id: string): void {
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

export function clearActiveWorkspaceId(): void {
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

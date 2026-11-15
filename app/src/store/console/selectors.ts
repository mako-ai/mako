/**
 * Console store selectors.
 */
import type { SettingsSection, TabKind, ConsoleTab } from "../lib/types";
import { findTab, type ConsoleStore } from "./types";

// Selectors
export const selectConsoleTabs = (state: ConsoleStore): ConsoleTab[] => {
  // Return tabs in tabOrder, falling back to insertion order for any orphans.
  const ordered: ConsoleTab[] = [];
  const seen = new Set<string>();
  for (const id of state.tabOrder) {
    const tab = state.tabs[id];
    if (tab) {
      ordered.push(tab);
      seen.add(id);
    }
  }
  for (const [id, tab] of Object.entries(state.tabs)) {
    if (!seen.has(id)) ordered.push(tab);
  }
  return ordered;
};
export const selectActiveConsoleId = (state: ConsoleStore) => state.activeTabId;
export const selectConsoleById =
  (id: string) =>
  (state: ConsoleStore): ConsoleTab | undefined =>
    state.tabs[id];
export const selectTabByKind =
  (kind: TabKind) =>
  (state: ConsoleStore): ConsoleTab | undefined =>
    findTab({ kind })(state);
export const selectTabBySettingsSection =
  (section: SettingsSection) =>
  (state: ConsoleStore): ConsoleTab | undefined =>
    findTab({
      kind: "settings",
      where: tab => tab.settingsSection === section,
    })(state);

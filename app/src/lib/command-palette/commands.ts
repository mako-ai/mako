/**
 * Command palette — static command registry.
 *
 * Commands are rebuilt on every palette render via `buildCommands()` so
 * availability can be derived from current store state (active tab kind,
 * open tabs, ...) without a reactive `when`-clause system. Keep entries
 * here in sync with what the underlying stores actually support.
 */

import {
  Copy,
  Monitor,
  Moon,
  PanelLeft,
  Plus,
  Sun,
  X,
  XCircle,
} from "lucide-react";
import { SECTION_LABELS, SECTION_ORDER } from "../../pages/settings/sections";
import {
  CHAT_ICON,
  EXPLORER_ICONS,
  SETTINGS_SECTION_ICONS,
} from "../entity-icons";
import {
  selectTabBySettingsSection,
  useConsoleStore,
} from "../../store/consoleStore";
import type { LeftPaneView, SettingsSection } from "../../store/lib/types";
import { useUIStore } from "../../store/uiStore";
import { tabUrlPath } from "../tab-routing";
import type { PaletteCommand } from "./types";

// Icons come from the shared EXPLORER_ICONS map so the palette always
// matches the sidebar rail (see lib/entity-icons.ts).
const EXPLORER_VIEWS: Array<{ view: LeftPaneView; label: string }> = [
  { view: "databases", label: "Databases" },
  { view: "consoles", label: "Consoles" },
  { view: "dashboards", label: "Dashboards" },
  { view: "apps", label: "Apps" },
  { view: "dbt", label: "Transforms" },
  { view: "flows", label: "Flows" },
  { view: "connectors", label: "Sources" },
  { view: "settings", label: "Settings" },
];

function openSettingsSection(section: SettingsSection): void {
  const state = useConsoleStore.getState();
  const existing = selectTabBySettingsSection(section)(state);
  if (existing) {
    state.setActiveTab(existing.id);
    return;
  }
  const id = state.openTab({
    title: SECTION_LABELS[section],
    content: "",
    kind: "settings",
    settingsSection: section,
  });
  state.setActiveTab(id);
}

export function buildCommands(options: {
  isSuperAdmin: boolean;
}): PaletteCommand[] {
  const consoleState = useConsoleStore.getState();
  const activeTab = consoleState.activeTabId
    ? consoleState.tabs[consoleState.activeTabId]
    : null;
  const tabCount = consoleState.tabOrder.length;

  const commands: PaletteCommand[] = [];

  commands.push({
    id: "create.console",
    title: "New console",
    section: "Create",
    keywords: ["query", "sql", "editor"],
    icon: Plus,
    run: () => {
      const state = useConsoleStore.getState();
      const id = state.openTab({ title: "New Console", content: "" });
      state.setActiveTab(id);
    },
  });

  for (const { view, label } of EXPLORER_VIEWS) {
    commands.push({
      id: `view.explorer.${view}`,
      title: `Go to ${label}`,
      section: "Navigate",
      keywords: ["explorer", "sidebar", label.toLowerCase()],
      icon: EXPLORER_ICONS[view],
      run: () => {
        const ui = useUIStore.getState();
        ui.navigateToView(view);
        ui.openLeftPane();
      },
    });
  }

  commands.push(
    {
      id: "view.toggleSidebar",
      title: "Toggle sidebar",
      section: "View",
      keywords: ["explorer", "left", "pane", "panel"],
      icon: PanelLeft,
      run: () => {
        const ui = useUIStore.getState();
        ui.setLeftPaneOpen(!ui.leftPaneOpen);
      },
    },
    {
      id: "view.toggleChat",
      title: "Toggle chat panel",
      section: "View",
      keywords: ["ask", "ai", "right", "pane", "assistant"],
      icon: CHAT_ICON,
      run: () => {
        const ui = useUIStore.getState();
        ui.setRightPaneOpen(!ui.rightPaneOpen);
      },
    },
  );

  commands.push(
    {
      id: "theme.light",
      title: "Theme: Light",
      section: "Appearance",
      keywords: ["color", "mode"],
      icon: Sun,
      run: ctx => ctx.setThemeMode("light"),
    },
    {
      id: "theme.dark",
      title: "Theme: Dark",
      section: "Appearance",
      keywords: ["color", "mode"],
      icon: Moon,
      run: ctx => ctx.setThemeMode("dark"),
    },
    {
      id: "theme.system",
      title: "Theme: System",
      section: "Appearance",
      keywords: ["color", "mode", "auto"],
      icon: Monitor,
      run: ctx => ctx.setThemeMode("system"),
    },
  );

  const settingsSections = SECTION_ORDER.filter(
    section => section !== "admin" || options.isSuperAdmin,
  );
  for (const section of settingsSections) {
    commands.push({
      id: `settings.${section}`,
      title: `Settings: ${SECTION_LABELS[section]}`,
      section: "Settings",
      keywords: ["preferences", "configure"],
      icon: SETTINGS_SECTION_ICONS[section],
      run: () => openSettingsSection(section),
    });
  }

  if (activeTab) {
    commands.push({
      id: "tab.close",
      title: "Close tab",
      section: "Tabs",
      keywords: ["current"],
      icon: X,
      run: () => {
        const state = useConsoleStore.getState();
        if (state.activeTabId) state.closeTab(state.activeTabId);
      },
    });

    const url = tabUrlPath(activeTab.id, activeTab);
    if (url) {
      commands.push({
        id: "tab.copyLink",
        title: "Copy link to tab",
        section: "Tabs",
        keywords: ["url", "share", "deep link"],
        icon: Copy,
        run: () => {
          void navigator.clipboard.writeText(`${window.location.origin}${url}`);
        },
      });
    }
  }

  if (tabCount > 1) {
    commands.push({
      id: "tab.closeOthers",
      title: "Close other tabs",
      section: "Tabs",
      keywords: ["all"],
      icon: XCircle,
      run: () => {
        const state = useConsoleStore.getState();
        const keep = state.activeTabId;
        for (const id of [...state.tabOrder]) {
          if (id !== keep) state.closeTab(id);
        }
      },
    });
  }

  return commands;
}

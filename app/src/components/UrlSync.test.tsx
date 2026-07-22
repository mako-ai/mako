// @vitest-environment jsdom
/**
 * UrlSync hydration — deep-linking a notebook URL.
 *
 * Regression coverage for "a shared /n/:id link opens a different object
 * (a console, another notebook) or redirects to root". The URL→tab mapping in
 * lib/tab-routing.ts is compile-exhaustive over TabKind, but UrlSync's
 * hydration is a hand-written if-chain that is NOT — the `notebook` branch was
 * missing, so `/n/:id` matched nothing, hydration no-op'd, and the sync effect
 * then rewrote the address bar to the persisted active tab's URL. This asserts
 * hydration actually opens the notebook tab for a /n/:id deep link.
 */
import { beforeEach, describe, expect, it, vi } from "vitest";
import { render, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => {
  const consoleState = {
    loadConsole: vi.fn(),
    openTab: vi.fn(),
    setActiveTab: vi.fn(),
    activeTabId: null as string | null,
    tabs: {} as Record<string, unknown>,
  };
  return {
    focusNotebookTab: vi.fn(),
    setLeftPane: vi.fn(),
    captureOAuthReturn: vi.fn(),
    consoleState,
    useConsoleStore: Object.assign(
      (selector: (s: typeof consoleState) => unknown) => selector(consoleState),
      { getState: () => consoleState },
    ),
  };
});

vi.mock("../notebook-runtime/shell", () => ({
  focusNotebookTab: h.focusNotebookTab,
}));
vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspace: { id: "ws1" } }),
}));
vi.mock("../contexts/auth-context", () => ({
  useAuth: () => ({ user: { id: "u1" } }),
}));
vi.mock("../store/consoleStore", () => ({
  useConsoleStore: h.useConsoleStore,
  selectTabBySettingsSection: () => () => undefined,
}));
vi.mock("../store/uiStore", () => ({
  useUIStore: (
    selector: (s: { leftPane: string; setLeftPane: unknown }) => unknown,
  ) => selector({ leftPane: "consoles", setLeftPane: h.setLeftPane }),
}));
vi.mock("../store/mcpStore", () => ({
  useMcpStore: {
    getState: () => ({ captureOAuthReturn: h.captureOAuthReturn }),
  },
}));

// Stores/shells only touched by branches the notebook path never enters; stub
// their named exports so module import resolves without pulling real deps.
vi.mock("../store/dashboardStore", () => ({
  useDashboardStore: { getState: () => ({}) },
}));
vi.mock("../store/appStore", () => ({ useAppStore: { getState: () => ({}) } }));
vi.mock("../store/dbtStore", () => ({ useDbtStore: { getState: () => ({}) } }));
vi.mock("../dashboard-runtime/shell", () => ({
  focusDashboardDataSourceTab: vi.fn(),
}));
vi.mock("../app-runtime/shell", () => ({
  focusAppBindingTab: vi.fn(),
  focusAppFileTab: vi.fn(),
  focusAppTab: vi.fn(),
}));
vi.mock("../dbt-runtime/shell", () => ({
  focusDbtConsoleTab: vi.fn(),
  focusDbtFileTab: vi.fn(),
  focusDbtJobTab: vi.fn(),
  focusDbtRunsTab: vi.fn(),
}));

import { UrlSync } from "./UrlSync";

describe("UrlSync hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.consoleState.activeTabId = null;
    h.consoleState.tabs = {};
  });

  it("opens the notebook tab when deep-linking /n/:id", async () => {
    window.history.replaceState(
      {},
      "",
      "/n/ce545d56-98d3-4d13-b1b5-0fd640fc1f5c",
    );

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusNotebookTab).toHaveBeenCalledWith(
        "ce545d56-98d3-4d13-b1b5-0fd640fc1f5c",
        expect.any(String),
      ),
    );
    expect(h.setLeftPane).toHaveBeenCalledWith("notebooks");
  });
});

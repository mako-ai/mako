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
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, render, waitFor } from "@testing-library/react";

const h = vi.hoisted(() => {
  const consoleState = {
    loadConsole: vi.fn(),
    openTab: vi.fn(),
    setActiveTab: vi.fn(),
    focusOrOpenTab: vi.fn(),
    activeTabId: null as string | null,
    tabs: {} as Record<string, unknown>,
  };
  return {
    focusNotebookTab: vi.fn(),
    closeNotebookTabsFor: vi.fn(),
    focusDashboardTab: vi.fn(),
    closeDashboardTabsFor: vi.fn(),
    resolveObjectRef: vi.fn().mockResolvedValue(null),
    setLeftPane: vi.fn(),
    captureOAuthReturn: vi.fn(),
    fetchOneSourceConnection: vi.fn(),
    closeSourceConnectionTabsFor: vi.fn(),
    focusAppsTab: vi.fn(),
    fetchApps: vi.fn().mockResolvedValue(undefined),
    apps: [{ id: "app1", slug: "seller-media", title: "Seller Media" }],
    consoleState,
    useConsoleStore: Object.assign(
      (selector: (s: typeof consoleState) => unknown) => selector(consoleState),
      { getState: () => consoleState },
    ),
  };
});

vi.mock("../notebook-runtime/shell", () => ({
  focusNotebookTab: h.focusNotebookTab,
  closeNotebookTabsFor: (...args: unknown[]) => h.closeNotebookTabsFor(...args),
}));
// The dead-link check for /n/:id and the rename service share one lookup.
vi.mock("../lib/object-links", () => ({
  resolveObjectRef: (...args: unknown[]) => h.resolveObjectRef(...args),
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
  useUIStore: Object.assign(
    (selector: (s: { leftPane: string; setLeftPane: unknown }) => unknown) =>
      selector({ leftPane: "consoles", setLeftPane: h.setLeftPane }),
    { getState: () => ({ leftPane: "consoles" }) },
  ),
}));
vi.mock("../store/mcpStore", () => ({
  useMcpStore: {
    getState: () => ({ captureOAuthReturn: h.captureOAuthReturn }),
  },
}));
vi.mock("../store/sourceConnectionEntitiesStore", () => ({
  useSourceConnectionEntitiesStore: {
    getState: () => ({ fetchOne: h.fetchOneSourceConnection }),
  },
}));
vi.mock("../lib/source-connection-tabs", () => ({
  closeSourceConnectionTabsFor: (...args: unknown[]) =>
    h.closeSourceConnectionTabsFor(...args),
}));

// Stores/shells only touched by branches the notebook path never enters; stub
// their named exports so module import resolves without pulling real deps.
vi.mock("../store/dbtStore", () => ({ useDbtStore: { getState: () => ({}) } }));
vi.mock("../dashboard-runtime/shell", () => ({
  focusDashboardDataSourceTab: vi.fn(),
  focusDashboardTab: (...args: unknown[]) => h.focusDashboardTab(...args),
  closeDashboardTabsFor: (...args: unknown[]) =>
    h.closeDashboardTabsFor(...args),
}));
vi.mock("../dbt-runtime/shell", () => ({
  focusDbtConsoleTab: vi.fn(),
  focusDbtFileTab: vi.fn(),
  focusDbtJobTab: vi.fn(),
  focusDbtRunsTab: vi.fn(),
}));

vi.mock("../apps-runtime/shell", () => ({
  closeAppsTabsFor: vi.fn(),
  focusAppsFileTab: vi.fn(),
  focusAppsTab: (...args: unknown[]) => h.focusAppsTab(...args),
}));
vi.mock("../store/appsStore", () => {
  const state = { fetchApps: h.fetchApps, apps: h.apps };
  return {
    useAppsStore: Object.assign(
      (selector: (s: typeof state) => unknown) => selector(state),
      { getState: () => state },
    ),
    // The real rule: a top-level app is addressed by its slug, anything
    // else by its id (no slug on the tab).
    appUrlSlug: (app: { id: string; slug?: string; path?: string }) =>
      app.slug && (app.path ?? `apps/${app.slug}`) === `apps/${app.slug}`
        ? app.slug
        : undefined,
  };
});

import { UrlSync } from "./UrlSync";

describe("UrlSync hydration", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    h.consoleState.activeTabId = null;
    h.consoleState.tabs = {};
  });
  // Unmount between tests: the dead-link Snackbar portals into body, and a
  // notice left open by one test must not be read by the next.
  afterEach(cleanup);

  /**
   * A shared app link carries the app's own query string. The published app
   * is a sandboxed iframe whose URL nobody can see, so the query on the HOST
   * URL is the only way a filtered view travels — and hydration has to hand
   * it to the tab before the outgoing sync rewrites the address bar.
   */
  it("hands the app's query string to the tab when deep-linking /apps/:slug?…", async () => {
    window.history.replaceState(
      {},
      "",
      "/apps/seller-media?filters.countries=PL&chart.breakdown=device",
    );

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusAppsTab).toHaveBeenCalledWith(
        "app1",
        "Seller Media",
        "seller-media",
        "?filters.countries=PL&chart.breakdown=device",
      ),
    );
    expect(h.setLeftPane).toHaveBeenCalledWith("apps");
  });

  it("opens the notebook tab when deep-linking /n/:id", async () => {
    const id = "ce545d56-98d3-4d13-b1b5-0fd640fc1f5c";
    h.resolveObjectRef.mockResolvedValue({
      kind: "notebook",
      id,
      via: "current",
      current: { title: "Churn study", url: `/n/${id}` },
    });
    window.history.replaceState({}, "", `/n/${id}`);

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusNotebookTab).toHaveBeenCalledWith(id, "Churn study"),
    );
    expect(h.resolveObjectRef).toHaveBeenCalledWith("ws1", "notebook", id);
    expect(h.setLeftPane).toHaveBeenCalledWith("notebooks");
    expect(h.closeNotebookTabsFor).not.toHaveBeenCalled();
  });

  it("focuses an already-open notebook tab without asking the server", async () => {
    const id = "ce545d56-98d3-4d13-b1b5-0fd640fc1f5c";
    h.consoleState.focusOrOpenTab.mockReturnValueOnce("tab-1");
    window.history.replaceState({}, "", `/n/${id}`);

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.setLeftPane).toHaveBeenCalledWith("notebooks"),
    );
    expect(h.resolveObjectRef).not.toHaveBeenCalled();
    expect(h.focusNotebookTab).not.toHaveBeenCalled();
  });

  it("shows the dead-link notice instead of a placeholder tab when /n/:id is gone", async () => {
    const id = "00000000-0000-4000-8000-000000000000";
    h.resolveObjectRef.mockResolvedValue(null);
    window.history.replaceState({}, "", `/n/${id}`);

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.closeNotebookTabsFor).toHaveBeenCalledWith(id),
    );
    expect(h.focusNotebookTab).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/");
    await waitFor(() =>
      expect(
        document.body.textContent?.includes(
          "That notebook link doesn't resolve",
        ),
      ).toBe(true),
    );
  });

  it("opens the placeholder notebook tab, with no notice, when the resolve call itself fails", async () => {
    const id = "ce545d56-98d3-4d13-b1b5-0fd640fc1f5d";
    h.resolveObjectRef.mockRejectedValue(new Error("HTTP error! status: 502"));
    window.history.replaceState({}, "", `/n/${id}`);

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusNotebookTab).toHaveBeenCalledWith(id, "Untitled notebook"),
    );
    expect(h.closeNotebookTabsFor).not.toHaveBeenCalled();
    expect(document.body.textContent?.includes("doesn't resolve")).toBe(false);
  });

  it("opens a dashboard tab with its title when /d/:id exists", async () => {
    const id = "507f1f77bcf86cd799439021";
    h.resolveObjectRef.mockResolvedValue({
      kind: "dashboard",
      id,
      via: "current",
      current: { title: "Revenue", url: `/d/${id}` },
    });
    window.history.replaceState({}, "", `/d/${id}`);

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusDashboardTab).toHaveBeenCalledWith(id, "Revenue"),
    );
    expect(h.resolveObjectRef).toHaveBeenCalledWith("ws1", "dashboard", id);
    expect(h.setLeftPane).toHaveBeenCalledWith("dashboards");
    expect(h.closeDashboardTabsFor).not.toHaveBeenCalled();
  });

  it("opens the placeholder dashboard tab, with no notice, when the resolve call itself fails", async () => {
    const id = "507f1f77bcf86cd799439023";
    h.resolveObjectRef.mockRejectedValue(new Error("HTTP error! status: 500"));
    window.history.replaceState({}, "", `/d/${id}`);

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusDashboardTab).toHaveBeenCalledWith(id, "Dashboard"),
    );
    expect(h.closeDashboardTabsFor).not.toHaveBeenCalled();
    expect(document.body.textContent?.includes("doesn't resolve")).toBe(false);
  });

  it("shows the dead-link notice instead of a blank 'Dashboard' tab when /d/:id is gone", async () => {
    const id = "507f1f77bcf86cd799439022";
    h.resolveObjectRef.mockResolvedValue(null);
    window.history.replaceState({}, "", `/d/${id}`);

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.closeDashboardTabsFor).toHaveBeenCalledWith(id),
    );
    expect(h.focusDashboardTab).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/");
    await waitFor(() =>
      expect(
        document.body.textContent?.includes(
          "That dashboard link doesn't resolve",
        ),
      ).toBe(true),
    );
  });

  it("opens a source-connection tab when /cx/:id still exists", async () => {
    const id = "507f1f77bcf86cd799439011";
    h.fetchOneSourceConnection.mockResolvedValue({
      _id: id,
      name: "Stripe",
    });
    window.history.replaceState({}, "", `/cx/${id}`);

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.consoleState.focusOrOpenTab).toHaveBeenCalledWith(
        { kind: "connectors", where: expect.any(Function) },
        expect.any(Function),
      ),
    );
    expect(h.setLeftPane).toHaveBeenCalledWith("connectors");
    expect(h.closeSourceConnectionTabsFor).not.toHaveBeenCalled();
  });

  it("does not leave a 404 tab when /cx/:id no longer resolves", async () => {
    const id = "507f1f77bcf86cd799439012";
    h.fetchOneSourceConnection.mockResolvedValue(null);
    window.history.replaceState({}, "", `/cx/${id}`);

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.closeSourceConnectionTabsFor).toHaveBeenCalledWith(id),
    );
    expect(h.consoleState.focusOrOpenTab).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/");
  });
});

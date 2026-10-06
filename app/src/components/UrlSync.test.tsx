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
import { render, screen, waitFor } from "@testing-library/react";

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
    setLeftPane: vi.fn(),
    captureOAuthReturn: vi.fn(),
    fetchOneSourceConnection: vi.fn(),
    closeSourceConnectionTabsFor: vi.fn(),
    // Opening a tab makes it the active one, whose URL the outgoing sync
    // then writes to the address bar — as the real shell does; without it
    // the sync would reset a resolved link to "/" (no active tab).
    focusAppsTab: vi.fn(
      (appId: string, title: string, slug?: string, search?: string) => {
        consoleState.tabs = {
          t1: {
            id: "t1",
            kind: "app",
            title,
            content: "",
            metadata: { appId, appSlug: slug, appSearch: search || undefined },
          },
        };
        consoleState.activeTabId = "t1";
        return "t1";
      },
    ),
    focusAppsFileTab: vi.fn((appId: string, path: string, slug?: string) => {
      consoleState.tabs = {
        t1: {
          id: "t1",
          kind: "app-file",
          title: path,
          content: "",
          metadata: { appId, appSlug: slug, path },
        },
      };
      consoleState.activeTabId = "t1";
      return "t1";
    }),
    closeAppsTabsFor: vi.fn(),
    resolveObjectRef: vi.fn().mockResolvedValue(null),
    fetchApps: vi.fn().mockResolvedValue(undefined),
    apps: [
      {
        id: "app1",
        slug: "seller-media",
        path: "apps/seller-media",
        title: "Seller Media",
        // Renamed from this: the server's index says so.
        aliases: ["seller-media-buying-3"],
      },
    ],
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
vi.mock("../store/dashboardStore", () => ({
  useDashboardStore: { getState: () => ({}) },
}));
vi.mock("../store/dbtStore", () => ({ useDbtStore: { getState: () => ({}) } }));
vi.mock("../dashboard-runtime/shell", () => ({
  focusDashboardDataSourceTab: vi.fn(),
}));
vi.mock("../dbt-runtime/shell", () => ({
  focusDbtConsoleTab: vi.fn(),
  focusDbtFileTab: vi.fn(),
  focusDbtJobTab: vi.fn(),
  focusDbtRunsTab: vi.fn(),
}));

vi.mock("../apps-runtime/shell", () => ({
  closeAppsTabsFor: (...args: unknown[]) => h.closeAppsTabsFor(...args),
  focusAppsFileTab: (...args: Parameters<typeof h.focusAppsFileTab>) =>
    h.focusAppsFileTab(...args),
  focusAppsTab: (...args: Parameters<typeof h.focusAppsTab>) =>
    h.focusAppsTab(...args),
}));
vi.mock("../lib/object-links", () => ({
  resolveObjectRef: (...args: unknown[]) => h.resolveObjectRef(...args),
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

  /**
   * A renamed app keeps resolving: the server records the old slug as an
   * alias, the list carries it, and an old link opens the app, rewrites the
   * address bar to the current one and says so — instead of "doesn't
   * resolve anymore" and a bounce to "/".
   */
  it("opens a renamed app from its old /apps/<slug> link and updates the address bar", async () => {
    window.history.replaceState({}, "", "/apps/seller-media-buying-3?tab=a");

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusAppsTab).toHaveBeenCalledWith(
        "app1",
        "Seller Media",
        "seller-media",
        "?tab=a",
      ),
    );
    expect(window.location.pathname + window.location.search).toBe(
      "/apps/seller-media?tab=a",
    );
    expect(await screen.findByText(/renamed/)).toBeTruthy();
    // The list answered; the server was not asked.
    expect(h.resolveObjectRef).not.toHaveBeenCalled();
    expect(h.closeAppsTabsFor).not.toHaveBeenCalled();
  });

  it("does the same for an old file link", async () => {
    window.history.replaceState(
      {},
      "",
      "/apps/seller-media-buying-3/file/src/main.tsx",
    );

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusAppsFileTab).toHaveBeenCalledWith(
        "app1",
        "src/main.tsx",
        "seller-media",
      ),
    );
    expect(window.location.pathname).toBe(
      "/apps/seller-media/file/src/main.tsx",
    );
  });

  it("asks the server when the list misses — a rename pushed a moment ago", async () => {
    h.resolveObjectRef.mockResolvedValueOnce({
      kind: "app",
      id: "6aaaed797eb3d8d53c497fd9",
      via: "alias",
      current: {
        title: "Fresh",
        slug: "fresh",
        path: "apps/fresh",
        url: "/apps/fresh",
      },
    });
    window.history.replaceState({}, "", "/apps/fresh-old-name");

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusAppsTab).toHaveBeenCalledWith(
        "6aaaed797eb3d8d53c497fd9",
        "Fresh",
        "fresh",
        "",
      ),
    );
    expect(h.resolveObjectRef).toHaveBeenCalledWith(
      "ws1",
      "app",
      "fresh-old-name",
    );
    // The list was refetched once more, for the row the tab renders from.
    expect(h.fetchApps).toHaveBeenCalledTimes(2);
    expect(window.location.pathname).toBe("/apps/fresh");
  });

  it("still reports a dead link when nothing resolves, closing no tab for a bare slug", async () => {
    window.history.replaceState({}, "", "/apps/ghost");

    render(<UrlSync />);

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(h.focusAppsTab).not.toHaveBeenCalled();
    // Tabs carry the id; a slug names none, so nothing is closed by mistake.
    expect(h.closeAppsTabsFor).not.toHaveBeenCalled();
    expect(await screen.findByText(/doesn't resolve/)).toBeTruthy();
  });

  it("treats the legacy /a/<ref> address as /apps/<ref>", async () => {
    window.history.replaceState({}, "", "/a/seller-media");

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusAppsTab).toHaveBeenCalledWith(
        "app1",
        "Seller Media",
        "seller-media",
        "",
      ),
    );
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

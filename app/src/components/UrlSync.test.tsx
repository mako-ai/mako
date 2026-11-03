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
    focusAppsTab: vi.fn(),
    closeAppsTabsFor: vi.fn(),
    fetchApps: vi.fn().mockResolvedValue(undefined),
    fetchViewUrl: vi.fn().mockResolvedValue(undefined),
    apps: [{ id: "app1", slug: "seller-media", title: "Seller Media" }],
    appsState: {
      apps: [] as Array<{ id: string; slug: string; title: string }>,
      appsCacheByWorkspace: {} as Record<string, unknown[]>,
    },
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
vi.mock("../store/dbtStore", () => ({ useDbtStore: { getState: () => ({}) } }));
vi.mock("../dbt-runtime/shell", () => ({
  focusDbtConsoleTab: vi.fn(),
  focusDbtFileTab: vi.fn(),
  focusDbtJobTab: vi.fn(),
  focusDbtRunsTab: vi.fn(),
}));

vi.mock("../apps-runtime/shell", () => ({
  closeAppsTabsFor: (...args: unknown[]) => h.closeAppsTabsFor(...args),
  focusAppsFileTab: vi.fn(),
  focusAppsTab: (...args: unknown[]) => h.focusAppsTab(...args),
}));
vi.mock("../store/appsStore", () => {
  const state = Object.assign(h.appsState, {
    fetchApps: h.fetchApps,
    fetchViewUrl: h.fetchViewUrl,
  });
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
    // A first visit: nothing cached, GET /apps brings the list.
    h.appsState.apps = [];
    h.appsState.appsCacheByWorkspace = {};
    h.fetchApps.mockImplementation(async () => {
      h.appsState.apps = h.apps;
    });
  });

  it("asks for the view token in parallel with GET /apps, by the link's ref", async () => {
    let finishList: () => void = () => undefined;
    h.fetchApps.mockImplementation(
      () =>
        new Promise<void>(resolve => {
          finishList = () => {
            h.appsState.apps = h.apps;
            resolve();
          };
        }),
    );
    window.history.replaceState({}, "", "/apps/seller-media");

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.fetchViewUrl).toHaveBeenCalledWith("ws1", "seller-media", {
        speculative: true,
      }),
    );
    // The list is still loading: no tab yet, the token is already asked for.
    expect(h.focusAppsTab).not.toHaveBeenCalled();
    finishList();
    await waitFor(() =>
      expect(h.focusAppsTab).toHaveBeenCalledWith(
        "app1",
        "Seller Media",
        "seller-media",
        "",
      ),
    );
  });

  it("opens a returning visitor's app from the cached list before GET /apps answers", async () => {
    h.appsState.appsCacheByWorkspace = { ws1: h.apps };
    h.fetchApps.mockImplementation(() => new Promise<void>(() => undefined));
    window.history.replaceState({}, "", "/apps/seller-media");

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusAppsTab).toHaveBeenCalledWith(
        "app1",
        "Seller Media",
        "seller-media",
        "",
      ),
    );
    // By id: the server answers an id from the app's row, without git.
    expect(h.fetchViewUrl).toHaveBeenCalledWith("ws1", "app1", {
      speculative: true,
    });
  });

  it("follows the fresh list when the cache named a different app", async () => {
    h.appsState.appsCacheByWorkspace = {
      ws1: [{ id: "old", slug: "seller-media", title: "Old Seller Media" }],
    };
    window.history.replaceState({}, "", "/apps/seller-media");

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusAppsTab).toHaveBeenLastCalledWith(
        "app1",
        "Seller Media",
        "seller-media",
        "",
      ),
    );
    expect(h.focusAppsTab).toHaveBeenCalledTimes(2);
  });

  it("still clears a dead app link once the fresh list lacks it", async () => {
    h.fetchApps.mockImplementation(async () => {
      h.appsState.apps = [];
    });
    window.history.replaceState({}, "", "/apps/gone-app");

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.closeAppsTabsFor).toHaveBeenCalledWith("gone-app"),
    );
    expect(h.focusAppsTab).not.toHaveBeenCalled();
    expect(window.location.pathname).toBe("/");
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

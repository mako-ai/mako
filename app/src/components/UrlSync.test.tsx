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
import { cleanup, render, screen, waitFor } from "@testing-library/react";

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
    user: { id: "u1" },
    focusNotebookTab: vi.fn(),
    setLeftPane: vi.fn(),
    captureOAuthReturn: vi.fn(),
    fetchOneSourceConnection: vi.fn(),
    closeSourceConnectionTabsFor: vi.fn(),
    focusAppsTab: vi.fn(),
    focusAppsFileTab: vi.fn(),
    closeAppsTabsFor: vi.fn(),
    resolveObjectRef: vi.fn(),
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
  // One user object, as the real context gives: a new one per render would
  // re-run the outgoing sync on every render and rewrite the address bar.
  useAuth: () => ({ user: h.user }),
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
  focusAppsFileTab: (...args: unknown[]) => h.focusAppsFileTab(...args),
  focusAppsTab: (...args: unknown[]) => h.focusAppsTab(...args),
}));
vi.mock("../lib/object-links", () => ({
  resolveObjectRef: (...args: unknown[]) => h.resolveObjectRef(...args),
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
  afterEach(cleanup);
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
    // The server knows no other name for anything, unless a test says so.
    h.resolveObjectRef.mockResolvedValue(null);
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
    expect(h.resolveObjectRef).toHaveBeenCalledWith("ws1", "app", "gone-app");
    expect(await screen.findByText(/doesn't resolve anymore/)).toBeTruthy();
  });

  /**
   * A renamed app keeps its old link (api/src/rename): the list does not
   * know the old name, the server does.
   */
  describe("an old link to a renamed app", () => {
    const renamed = {
      kind: "app",
      id: "app1",
      via: "alias",
      current: {
        title: "Seller Media",
        slug: "seller-media",
        path: "apps/seller-media",
        url: "/apps/seller-media",
      },
    };

    it("opens the app, shows its new address and says it was renamed", async () => {
      h.resolveObjectRef.mockResolvedValue(renamed);
      window.history.replaceState({}, "", "/apps/media-buying?country=PL");

      render(<UrlSync />);

      await waitFor(() =>
        expect(h.focusAppsTab).toHaveBeenCalledWith(
          "app1",
          "Seller Media",
          "seller-media",
          "?country=PL",
        ),
      );
      expect(h.resolveObjectRef).toHaveBeenCalledWith(
        "ws1",
        "app",
        "media-buying",
      );
      expect(window.location.pathname + window.location.search).toBe(
        "/apps/seller-media?country=PL",
      );
      expect(await screen.findByText(/That app was renamed/)).toBeTruthy();
      expect(h.closeAppsTabsFor).not.toHaveBeenCalled();
    });

    it("opens a file of it under the new address too", async () => {
      h.resolveObjectRef.mockResolvedValue(renamed);
      window.history.replaceState(
        {},
        "",
        "/apps/media-buying/file/src/App.tsx",
      );

      render(<UrlSync />);

      await waitFor(() =>
        expect(h.focusAppsFileTab).toHaveBeenCalledWith(
          "app1",
          "src/App.tsx",
          "seller-media",
        ),
      );
      expect(window.location.pathname).toBe(
        "/apps/seller-media/file/src/App.tsx",
      );
      expect(await screen.findByText(/That app was renamed/)).toBeTruthy();
    });

    it("uses the id in the address of a nested app, and says nothing for a name that is current", async () => {
      // The server knows an app the list has not caught up with yet.
      h.resolveObjectRef.mockResolvedValue({
        kind: "app",
        id: "0123456789abcdef01234567",
        via: "current",
        current: { title: "Nested", url: "/apps/0123456789abcdef01234567" },
      });
      window.history.replaceState({}, "", "/apps/Team%2Fnested");

      render(<UrlSync />);

      await waitFor(() =>
        expect(h.focusAppsTab).toHaveBeenCalledWith(
          "0123456789abcdef01234567",
          "Nested",
          undefined,
          "",
        ),
      );
      expect(screen.queryByText(/renamed/)).toBeNull();
    });

    it.each(["/apps/media-buying", "/apps/media-buying/file/src/App.tsx"])(
      "does not call %s dead when the server cannot answer: unknown is not gone",
      async url => {
        h.resolveObjectRef.mockRejectedValue(new Error("502"));
        window.history.replaceState({}, "", url);

        render(<UrlSync />);

        await waitFor(() => expect(h.resolveObjectRef).toHaveBeenCalled());
        await new Promise(resolve => setTimeout(resolve, 0));
        expect(h.closeAppsTabsFor).not.toHaveBeenCalled();
        expect(h.focusAppsTab).not.toHaveBeenCalled();
        expect(h.focusAppsFileTab).not.toHaveBeenCalled();
        expect(screen.queryByText(/doesn't resolve anymore/)).toBeNull();
        expect(screen.queryByText(/renamed/)).toBeNull();
      },
    );
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

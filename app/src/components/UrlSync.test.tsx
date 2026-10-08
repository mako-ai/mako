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
    // One object, as the real auth context holds: a fresh user per render
    // would re-run the outgoing URL sync on every render and hide an
    // address-bar bug the app has.
    user: { id: "u1" },
    workspace: { id: "ws1" },
    focusNotebookTab: vi.fn(),
    closeNotebookTabsFor: vi.fn(),
    focusDashboardTab: vi.fn(),
    closeDashboardTabsFor: vi.fn(),
    resolveObjectRef: vi.fn().mockResolvedValue(null),
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
    // Opening a flow tab makes it the active one, as the real shell does.
    focusFlowTabById: vi.fn((flowId: string, title = "Flow") => {
      consoleState.tabs = {
        f1: {
          id: "f1",
          kind: "flow-editor",
          title,
          content: "",
          metadata: { flowId },
        },
      };
      consoleState.activeTabId = "f1";
      return "f1";
    }),
    closeFlowTabsFor: vi.fn(),
    flowState: {
      flows: {} as Record<string, Array<{ _id: string; name: string }>>,
    },
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
  closeNotebookTabsFor: (...args: unknown[]) => h.closeNotebookTabsFor(...args),
}));
// The dead-link check for /n/:id and the rename service share one lookup.
vi.mock("../lib/object-links", () => ({
  resolveObjectRef: (...args: unknown[]) => h.resolveObjectRef(...args),
}));
vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspace: h.workspace }),
}));
vi.mock("../contexts/auth-context", () => ({
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

vi.mock("../flow-runtime/shell", () => ({
  focusFlowTabById: (...args: Parameters<typeof h.focusFlowTabById>) =>
    h.focusFlowTabById(...args),
  closeFlowTabsFor: (...args: unknown[]) => h.closeFlowTabsFor(...args),
  getFlowTitle: (flow: { name: string }) => flow.name,
}));
vi.mock("../store/flowStore", () => ({
  useFlowStore: { getState: () => h.flowState },
}));

vi.mock("../apps-runtime/shell", () => ({
  closeAppsTabsFor: (...args: unknown[]) => h.closeAppsTabsFor(...args),
  focusAppsFileTab: (...args: Parameters<typeof h.focusAppsFileTab>) =>
    h.focusAppsFileTab(...args),
  focusAppsTab: (...args: Parameters<typeof h.focusAppsTab>) =>
    h.focusAppsTab(...args),
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
    // No globals here, so testing-library does not unmount between tests on
    // its own; a snackbar left by the previous test would match again.
    cleanup();
    vi.clearAllMocks();
    h.consoleState.activeTabId = null;
    h.consoleState.tabs = {};
    h.consoleState.focusOrOpenTab.mockReturnValue(null);
    h.flowState.flows = {};
    // clearAllMocks keeps queued and persistent answers; one test's unused
    // answer must not become the next test's.
    h.resolveObjectRef.mockReset();
    h.resolveObjectRef.mockResolvedValue(null);
    h.fetchOneSourceConnection.mockReset();
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

  /**
   * A renamed app keeps resolving: the server records the old slug as an
   * alias, the list carries it, and an old link opens the app, rewrites the
   * address bar to the current one and says so — instead of "doesn't
   * resolve anymore" and a bounce to "/".
   */
  it("opens a renamed app from its old /apps/<slug> link and updates the address bar", async () => {
    h.resolveObjectRef.mockResolvedValueOnce({
      kind: "app",
      id: "app1",
      via: "alias",
      current: {
        title: "Seller Media",
        slug: "seller-media",
        path: "apps/seller-media",
        url: "/apps/seller-media",
      },
    });
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
    // The list knew the alias, and the server was still asked — it sees
    // every app, the list only those this person may see.
    expect(h.resolveObjectRef).toHaveBeenCalledWith(
      "ws1",
      "app",
      "seller-media-buying-3",
    );
    // The app is listed already: no second list fetch.
    expect(h.fetchApps).toHaveBeenCalledTimes(1);
    expect(h.closeAppsTabsFor).not.toHaveBeenCalled();
  });

  it("says an app filed into a folder under the same name MOVED, not renamed", async () => {
    // apps/revenue-board → apps/finance/revenue-board: the top-level link
    // is an alias now, and the app is addressed by its id.
    h.resolveObjectRef.mockResolvedValueOnce({
      kind: "app",
      id: "6aaaed797eb3d8d53c497fd1",
      via: "alias",
      current: {
        title: "Revenue Board",
        slug: "revenue-board",
        path: "apps/finance/revenue-board",
        url: "/apps/6aaaed797eb3d8d53c497fd1",
      },
    });
    window.history.replaceState({}, "", "/apps/revenue-board");

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusAppsTab).toHaveBeenCalledWith(
        "6aaaed797eb3d8d53c497fd1",
        "Revenue Board",
        undefined,
        "",
      ),
    );
    expect(window.location.pathname).toBe("/apps/6aaaed797eb3d8d53c497fd1");
    expect(
      await screen.findByText("That app moved — the link has been updated."),
    ).toBeTruthy();
    expect(screen.queryByText(/renamed/)).toBeNull();
  });

  it("trusts the server over the list for an old name: ambiguous there means a dead link here", async () => {
    // The list resolves the alias, the server does not (another app this
    // person cannot see claims the same old name).
    h.resolveObjectRef.mockResolvedValueOnce(null);
    window.history.replaceState({}, "", "/apps/seller-media-buying-3");

    render(<UrlSync />);

    await waitFor(() => expect(window.location.pathname).toBe("/"));
    expect(h.focusAppsTab).not.toHaveBeenCalled();
    expect(await screen.findByText(/doesn't resolve/)).toBeTruthy();
  });

  it("does the same for an old file link", async () => {
    h.resolveObjectRef.mockResolvedValueOnce({
      kind: "app",
      id: "app1",
      via: "alias",
      current: {
        title: "Seller Media",
        slug: "seller-media",
        path: "apps/seller-media",
        url: "/apps/seller-media",
      },
    });
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
    // Not in the list yet: refetched once more, for the row the tab renders from.
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

  it("does not call an app link dead when the server cannot answer", async () => {
    h.resolveObjectRef.mockRejectedValueOnce(new Error("503"));
    window.history.replaceState({}, "", "/apps/ghost");

    render(<UrlSync />);

    await waitFor(() => expect(h.resolveObjectRef).toHaveBeenCalled());
    await new Promise(resolve => setTimeout(resolve, 20));
    // No "doesn't resolve" verdict and no tab closed on an unknown answer
    // (the address bar then follows the active tab, as after any hydration).
    expect(h.closeAppsTabsFor).not.toHaveBeenCalled();
    expect(screen.queryByText(/doesn't resolve/)).toBeNull();
  });

  it("opens an old name the list knows when the server cannot answer", async () => {
    h.resolveObjectRef.mockRejectedValueOnce(new Error("503"));
    window.history.replaceState({}, "", "/apps/seller-media-buying-3");

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
  /**
   * A flow is addressed /f/<id>, but a slug in that slot — typed, or an old
   * name kept in a bookmark — must not read as "deleted": the rename dialog
   * promises the old name keeps working, and the server resolves it.
   */
  describe("flow links", () => {
    const FLOW_ID = "6a1b2c3d4e5f6a7b8c9d0e1f";

    it("opens a renamed flow from its old slug and rewrites the address to /f/<id>", async () => {
      h.resolveObjectRef.mockResolvedValueOnce({
        kind: "flow",
        id: FLOW_ID,
        via: "alias",
        current: { title: "Orders v3 sync", url: `/f/${FLOW_ID}` },
      });
      window.history.replaceState({}, "", "/f/orders-sync");

      render(<UrlSync />);

      await waitFor(() =>
        expect(h.focusFlowTabById).toHaveBeenCalledWith(
          FLOW_ID,
          "Orders v3 sync",
        ),
      );
      expect(h.resolveObjectRef).toHaveBeenCalledWith(
        "ws1",
        "flow",
        "orders-sync",
      );
      expect(window.location.pathname).toBe(`/f/${FLOW_ID}`);
      expect(await screen.findByText(/That flow was renamed/)).toBeTruthy();
      expect(screen.queryByText(/deleted/)).toBeNull();
      // The placeholder an older build opened for the slug is cleaned up.
      expect(h.closeFlowTabsFor).toHaveBeenCalledWith("orders-sync");
      expect(h.setLeftPane).toHaveBeenCalledWith("flows");
    });

    it("opens a flow by its current slug without calling it renamed", async () => {
      h.resolveObjectRef.mockResolvedValueOnce({
        kind: "flow",
        id: FLOW_ID,
        via: "current",
        current: { title: "Orders v3 sync", url: `/f/${FLOW_ID}` },
      });
      window.history.replaceState({}, "", "/f/orders-v3-sync");

      render(<UrlSync />);

      await waitFor(() =>
        expect(window.location.pathname).toBe(`/f/${FLOW_ID}`),
      );
      expect(h.focusFlowTabById).toHaveBeenCalledWith(
        FLOW_ID,
        "Orders v3 sync",
      );
      await new Promise(resolve => setTimeout(resolve, 20));
      expect(screen.queryByText(/renamed/)).toBeNull();
    });

    it("opens a listed flow id without asking the server", async () => {
      h.flowState.flows = { ws1: [{ _id: FLOW_ID, name: "Orders v3 sync" }] };
      window.history.replaceState({}, "", `/f/${FLOW_ID}`);

      render(<UrlSync />);

      await waitFor(() =>
        expect(h.focusFlowTabById).toHaveBeenCalledWith(
          FLOW_ID,
          "Orders v3 sync",
        ),
      );
      expect(h.resolveObjectRef).not.toHaveBeenCalled();
    });

    it("reports a dead link only on a real not-found, and leaves the address on the shown tab", async () => {
      h.consoleState.tabs = {
        c1: { id: "c1", kind: "console", title: "Scratch", content: "" },
      };
      h.consoleState.activeTabId = "c1";
      h.resolveObjectRef.mockResolvedValueOnce(null);
      window.history.replaceState({}, "", `/f/${FLOW_ID}`);

      render(<UrlSync />);

      await waitFor(() =>
        expect(h.closeFlowTabsFor).toHaveBeenCalledWith(FLOW_ID),
      );
      expect(h.focusFlowTabById).not.toHaveBeenCalled();
      expect(await screen.findByText(/flow link doesn't resolve/)).toBeTruthy();
      expect(window.location.pathname).toBe("/c/c1");
    });

    it("does not call a flow name deleted when the server cannot answer", async () => {
      h.resolveObjectRef.mockRejectedValueOnce(new Error("HTTP 503"));
      window.history.replaceState({}, "", "/f/orders-sync");

      render(<UrlSync />);

      expect(await screen.findByText(/didn't answer/)).toBeTruthy();
      expect(screen.queryByText(/deleted|doesn't resolve/)).toBeNull();
      expect(h.focusFlowTabById).not.toHaveBeenCalled();
      expect(window.location.pathname).toBe("/");
    });

    it("still opens a flow id when the server cannot answer", async () => {
      h.resolveObjectRef.mockRejectedValueOnce(new Error("HTTP 503"));
      window.history.replaceState({}, "", `/f/${FLOW_ID}`);

      render(<UrlSync />);

      await waitFor(() =>
        expect(h.focusFlowTabById).toHaveBeenCalledWith(FLOW_ID),
      );
      expect(h.closeFlowTabsFor).not.toHaveBeenCalled();
      expect(screen.queryByText(/doesn't resolve|didn't answer/)).toBeNull();
    });
  });

  /**
   * A dead link opens no tab, so whatever tab was open before stays on
   * screen; the address bar must name THAT tab, not "/".
   */
  describe("address bar after a dead link", () => {
    beforeEach(() => {
      h.consoleState.tabs = {
        c1: { id: "c1", kind: "console", title: "Scratch", content: "" },
      };
      h.consoleState.activeTabId = "c1";
    });

    it("app", async () => {
      h.resolveObjectRef.mockResolvedValueOnce(null);
      window.history.replaceState({}, "", "/apps/ghost");

      render(<UrlSync />);

      expect(await screen.findByText(/app link doesn't resolve/)).toBeTruthy();
      expect(window.location.pathname).toBe("/c/c1");
    });

    it("app file", async () => {
      h.resolveObjectRef.mockResolvedValueOnce(null);
      window.history.replaceState({}, "", "/apps/ghost/file/src/main.tsx");

      render(<UrlSync />);

      expect(await screen.findByText(/app link doesn't resolve/)).toBeTruthy();
      expect(window.location.pathname).toBe("/c/c1");
    });

    it("notebook", async () => {
      h.resolveObjectRef.mockResolvedValueOnce(null);
      window.history.replaceState(
        {},
        "",
        "/n/00000000-0000-4000-8000-000000000001",
      );

      render(<UrlSync />);

      expect(
        await screen.findByText(/notebook link doesn't resolve/),
      ).toBeTruthy();
      expect(window.location.pathname).toBe("/c/c1");
    });

    it("dashboard", async () => {
      h.resolveObjectRef.mockResolvedValueOnce(null);
      window.history.replaceState({}, "", "/d/507f1f77bcf86cd799439031");

      render(<UrlSync />);

      expect(
        await screen.findByText(/dashboard link doesn't resolve/),
      ).toBeTruthy();
      expect(window.location.pathname).toBe("/c/c1");
    });

    it("source connection", async () => {
      h.fetchOneSourceConnection.mockResolvedValueOnce(null);
      window.history.replaceState({}, "", "/cx/507f1f77bcf86cd799439032");

      render(<UrlSync />);

      expect(
        await screen.findByText(/source connection link doesn't resolve/),
      ).toBeTruthy();
      expect(window.location.pathname).toBe("/c/c1");
    });

    it("falls back to / when no tab is left open", async () => {
      h.consoleState.tabs = {};
      h.consoleState.activeTabId = null;
      h.resolveObjectRef.mockResolvedValueOnce(null);
      window.history.replaceState({}, "", "/apps/ghost");

      render(<UrlSync />);

      expect(await screen.findByText(/app link doesn't resolve/)).toBeTruthy();
      expect(window.location.pathname).toBe("/");
    });
  });
});

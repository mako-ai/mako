// @vitest-environment jsdom
/**
 * UrlSync hydration — a dbt file deep link outlives a rename.
 *
 * `/x/:projectId/file/<path>` names a file by path. After a rename (UI, MCP
 * or a laptop `git mv`) the old link used to open a tab on a path that no
 * longer existed. Now hydration lists the project, asks the server where a
 * missing path went (`GET /objects/resolve`), opens the file under its new
 * name, rewrites the address bar and says so. A path that still exists, or
 * one nothing answers for, opens exactly as before.
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
  const dbtState = {
    fetchFiles: vi.fn().mockResolvedValue(undefined),
    filePathsByProject: {} as Record<string, string[]>,
  };
  return {
    setLeftPane: vi.fn(),
    captureOAuthReturn: vi.fn(),
    focusDbtFileTab: vi.fn(),
    resolveObjectRef: vi.fn(),
    consoleState,
    dbtState,
    useConsoleStore: Object.assign(
      (selector: (s: typeof consoleState) => unknown) => selector(consoleState),
      { getState: () => consoleState },
    ),
  };
});

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
vi.mock("../store/dbtStore", () => ({
  useDbtStore: { getState: () => h.dbtState },
}));
vi.mock("../dbt-runtime/shell", () => ({
  focusDbtConsoleTab: vi.fn(),
  focusDbtFileTab: (...args: unknown[]) => h.focusDbtFileTab(...args),
  focusDbtJobTab: vi.fn(),
  focusDbtRunsTab: vi.fn(),
}));
vi.mock("../lib/object-links", () => ({
  resolveObjectRef: (...args: unknown[]) => h.resolveObjectRef(...args),
}));

// Branches this suite never enters: stub named exports so the import resolves.
vi.mock("../notebook-runtime/shell", () => ({ focusNotebookTab: vi.fn() }));
vi.mock("../store/sourceConnectionEntitiesStore", () => ({
  useSourceConnectionEntitiesStore: { getState: () => ({ fetchOne: vi.fn() }) },
}));
vi.mock("../lib/source-connection-tabs", () => ({
  closeSourceConnectionTabsFor: vi.fn(),
}));
vi.mock("../store/dashboardStore", () => ({
  useDashboardStore: { getState: () => ({}) },
}));
vi.mock("../dashboard-runtime/shell", () => ({
  focusDashboardDataSourceTab: vi.fn(),
  focusDashboardTab: vi.fn(),
}));
vi.mock("../flow-runtime/shell", () => ({ focusFlowTabById: vi.fn() }));
vi.mock("../apps-runtime/shell", () => ({
  closeAppsTabsFor: vi.fn(),
  focusAppsFileTab: vi.fn(),
  focusAppsTab: vi.fn(),
}));
vi.mock("../store/appsStore", () => ({
  useAppsStore: Object.assign(() => undefined, { getState: () => ({}) }),
  appUrlSlug: () => undefined,
}));

import { UrlSync } from "./UrlSync";

const PID = "507f1f77bcf86cd799439011";

describe("UrlSync hydration — dbt file links", () => {
  // No vitest globals here, so testing-library does not unmount between
  // tests on its own; a snackbar from one case must not leak into the next.
  afterEach(cleanup);

  beforeEach(() => {
    vi.clearAllMocks();
    h.consoleState.activeTabId = null;
    h.consoleState.tabs = {};
    h.dbtState.filePathsByProject = {};
    h.dbtState.fetchFiles.mockResolvedValue(undefined);
  });

  it("opens a file that still exists without asking the server", async () => {
    h.dbtState.filePathsByProject = { [PID]: ["models/orders.sql"] };
    window.history.replaceState({}, "", `/x/${PID}/file/models/orders.sql`);

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusDbtFileTab).toHaveBeenCalledWith(PID, "models/orders.sql"),
    );
    expect(h.resolveObjectRef).not.toHaveBeenCalled();
    expect(h.setLeftPane).toHaveBeenCalledWith("dbt");
  });

  it("follows a renamed path: opens the new file, rewrites the URL, says so", async () => {
    h.dbtState.filePathsByProject = { [PID]: ["models/fct_orders.sql"] };
    h.resolveObjectRef.mockResolvedValue({
      kind: "dbt_file",
      id: `${PID}/models/fct_orders.sql`,
      via: "alias",
      current: {
        slug: "models/fct_orders.sql",
        url: `/x/${PID}/file/models/fct_orders.sql`,
      },
    });
    window.history.replaceState({}, "", `/x/${PID}/file/models/orders.sql`);
    const replaceState = vi.spyOn(window.history, "replaceState");

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusDbtFileTab).toHaveBeenCalledWith(
        PID,
        "models/fct_orders.sql",
      ),
    );
    expect(h.resolveObjectRef).toHaveBeenCalledWith(
      "ws1",
      "dbt_file",
      `${PID}/models/orders.sql`,
    );
    expect(h.focusDbtFileTab).not.toHaveBeenCalledWith(
      PID,
      "models/orders.sql",
    );
    // The address bar is rewritten to the live path (the outgoing sync then
    // keeps it on the active tab, which under these stubs is none).
    expect(replaceState).toHaveBeenCalledWith(
      null,
      "",
      `/x/${PID}/file/models/fct_orders.sql`,
    );
    expect(
      await screen.findByText(
        "File moved: models/orders.sql → models/fct_orders.sql",
      ),
    ).toBeTruthy();
  });

  it("opens the asked-for path when nothing answers for it (the editor reports it)", async () => {
    h.dbtState.filePathsByProject = { [PID]: ["models/other.sql"] };
    h.resolveObjectRef.mockResolvedValue(null);
    window.history.replaceState({}, "", `/x/${PID}/file/models/gone.sql`);

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusDbtFileTab).toHaveBeenCalledWith(PID, "models/gone.sql"),
    );
    expect(h.resolveObjectRef).toHaveBeenCalledTimes(1);
    expect(screen.queryByText(/File moved/)).toBeNull();
  });

  it("opens blind when the listing itself failed (a branch the list may not know)", async () => {
    // fetchFiles resolved but recorded nothing: no list to judge by.
    window.history.replaceState({}, "", `/x/${PID}/file/models/orders.sql`);

    render(<UrlSync />);

    await waitFor(() =>
      expect(h.focusDbtFileTab).toHaveBeenCalledWith(PID, "models/orders.sql"),
    );
    expect(h.resolveObjectRef).not.toHaveBeenCalled();
  });
});

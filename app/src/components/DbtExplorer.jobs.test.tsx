// @vitest-environment jsdom
/**
 * The Jobs & runs list: a right-click on a job row opens the same menu as
 * its hover "Job actions" button, and Rename… hands the dialog the other
 * jobs' file names (so a taken one is refused as it is typed).
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const noop = vi.hoisted(() => () => undefined);
const renameTargets = vi.hoisted(() => [] as unknown[]);
const state = vi.hoisted(() => ({
  projects: [
    {
      _id: "p1",
      name: "Analytics",
      defaultEnvironment: "prod",
      environments: [],
    },
  ],
  projectsLoaded: true,
  activeProjectId: "p1",
  filePathsByProject: { p1: [] },
  jobsByProject: {
    p1: [
      {
        _id: "j1",
        projectId: "p1",
        name: "Nightly",
        slug: "nightly",
        environment: "prod",
        commands: ["build"],
        enabled: true,
      },
      {
        _id: "j2",
        projectId: "p1",
        name: "Hourly",
        slug: "hourly",
        environment: "prod",
        commands: ["build"],
        enabled: true,
      },
    ],
  },
  loading: {},
  error: {},
}));
vi.mock("../store/dbtStore", () => ({
  // Every action the explorer asks the store for is a no-op here.
  useDbtStore: (selector: (s: unknown) => unknown) =>
    selector(
      new Proxy(state, {
        get: (target, key) =>
          key in target ? target[key as keyof typeof target] : noop,
      }),
    ),
}));
vi.mock("../store/consoleStore", () => {
  const store = { activeTabId: null, tabs: {}, updateTitle: noop };
  const useConsoleStore = (selector: (s: typeof store) => unknown) =>
    selector(store);
  useConsoleStore.getState = () => store;
  return { useConsoleStore };
});
vi.mock("../store/explorerStore", () => ({
  useExplorerStore: (selector: (s: unknown) => unknown) =>
    selector({
      dbt: { expandedFolders: {} },
      toggleDbtFolder: noop,
      expandDbtFolder: noop,
    }),
}));
vi.mock("../store/explorerRevealStore", () => ({
  useExplorerRevealStore: () => null,
  selectRevealFor: () => () => null,
}));
vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspace: { id: "ws1" } }),
}));
vi.mock("../dbt-runtime/shell", () => ({
  focusDbtConsoleTab: noop,
  focusDbtFileTab: noop,
  focusDbtJobTab: noop,
  focusDbtRunsTab: noop,
}));
vi.mock("./ResourceTree", () => ({ default: () => null }));
vi.mock("./ExplorerShell", () => ({
  default: ({
    children,
  }: {
    children: (args: { searchQuery: string }) => unknown;
  }) => children({ searchQuery: "" }),
}));
vi.mock("./RenameObjectDialog", () => ({
  RenameObjectDialog: ({ target }: { target: unknown }) => {
    if (target) renameTargets.push(target);
    return null;
  },
}));

import { DbtExplorer } from "./DbtExplorer";

afterEach(() => {
  cleanup();
  renameTargets.length = 0;
});

const menuItems = () =>
  screen.queryAllByRole("menuitem").map(item => item.textContent);

describe("a job row in Jobs & runs", () => {
  it("opens Open / Rename… / Delete on right-click, as the Job actions button does", () => {
    render(<DbtExplorer />);
    const row = screen
      .getByText("Nightly")
      .closest('[role="button"]') as HTMLElement;
    expect(menuItems()).toEqual([]);
    // Not cancelled = the browser's own menu would open instead.
    expect(fireEvent.contextMenu(row)).toBe(false);
    expect(menuItems()).toEqual(["Open", "Rename…", "Delete"]);
    fireEvent.keyDown(screen.getByRole("menu"), { key: "Escape" });

    fireEvent.click(screen.getAllByLabelText("Job actions")[0]);
    expect(menuItems()).toEqual(["Open", "Rename…", "Delete"]);
  });

  it("Rename… names the job and the file names the other jobs hold", () => {
    render(<DbtExplorer />);
    fireEvent.contextMenu(screen.getByText("Nightly"));
    fireEvent.click(screen.getByText("Rename…"));
    expect(renameTargets.at(-1)).toEqual({
      kind: "dbt_job",
      ref: "j1",
      title: "Nightly",
      slug: "nightly",
      others: [{ slug: "hourly", title: "Hourly" }],
    });
  });
});

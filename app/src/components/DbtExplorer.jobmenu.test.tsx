// @vitest-environment jsdom
/**
 * Right-clicking a dbt job in the explorer opens its actions — Open,
 * Rename…, Delete — as the hover kebab does (browser pass shots7/s7-22: the
 * right-click menu was empty, so the Edit form was the only way to rename a
 * job). Rename… opens the shared RenameObjectDialog on that job.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

vi.hoisted(() => {
  // jsdom on Node 26: a working localStorage for the persisted stores.
  const data = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => data.get(k) ?? null,
      setItem: (k: string, v: string) => void data.set(k, String(v)),
      removeItem: (k: string) => void data.delete(k),
      clear: () => data.clear(),
      key: (i: number) => [...data.keys()][i] ?? null,
      get length() {
        return data.size;
      },
    },
  });
});
vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspace: { id: "ws1" } }),
}));

import { DbtExplorer } from "./DbtExplorer";
import { useDbtStore } from "../store/dbtStore";

afterEach(() => cleanup());

beforeEach(() => {
  const noop = vi.fn(async () => undefined);
  useDbtStore.setState({
    projects: [
      {
        _id: "p1",
        name: "Analytics",
        defaultEnvironment: "prod",
        environments: [{ name: "prod", targetSchema: "dbt_prod" }],
      },
    ] as never,
    projectsLoaded: true,
    activeProjectId: "p1",
    filePathsByProject: { p1: [] },
    jobsByProject: {
      p1: [
        {
          _id: "j1",
          projectId: "p1",
          name: "Nightly build",
          slug: "nightly-build",
          environment: "prod",
          commands: ["build"],
          schedule: null,
          enabled: true,
          deferToProduction: false,
        },
      ],
    } as never,
    fetchProjects: noop,
    fetchFiles: noop,
    fetchJobs: noop,
  } as never);
});

describe("a dbt job's right-click menu", () => {
  it("offers Open, Rename… and Delete; Rename… opens the rename dialog on that job", () => {
    render(<DbtExplorer />);
    const row = screen.getByText("Nightly build");
    fireEvent.contextMenu(row);
    expect(screen.getByRole("menuitem", { name: /Open/ })).toBeTruthy();
    expect(screen.getByRole("menuitem", { name: /Delete/ })).toBeTruthy();
    fireEvent.click(screen.getByRole("menuitem", { name: "Rename…" }));
    expect(screen.getByText("Rename job")).toBeTruthy();
    const [name, file] = screen.getAllByRole("textbox") as HTMLInputElement[];
    expect(name.value).toBe("Nightly build");
    expect(file.value).toBe("nightly-build");
    // …and the dialog applies the same rules as the server.
    fireEvent.change(name, { target: { value: "x".repeat(129) } });
    expect(
      screen.getByText("The name is longer than 128 characters."),
    ).toBeTruthy();
  });
});

// @vitest-environment jsdom
/**
 * The job Edit form's name field refuses, as it is typed, what the server
 * would: the same rules and words (lib/object-name-rules.ts) as the Rename
 * dialog, with Save disabled.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const saveJob = vi.hoisted(() => vi.fn(async () => true));
const state = vi.hoisted(() => ({
  projects: [
    {
      _id: "p1",
      name: "Analytics",
      defaultEnvironment: "prod",
      environments: [{ name: "prod", targetSchema: "dbt_prod" }],
    },
  ],
  jobsByProject: {
    p1: [
      {
        _id: "j1",
        projectId: "p1",
        name: "Nightly",
        slug: "nightly",
        environment: "prod",
        commands: ["build"],
        schedule: null,
        enabled: true,
        deferToProduction: false,
      },
    ],
  },
  loadErrors: {},
  runsByJob: {},
  error: {},
  fetchProjects: vi.fn(async () => undefined),
  fetchJobs: vi.fn(async () => undefined),
  fetchRuns: vi.fn(async () => undefined),
  triggerJob: vi.fn(),
  cancelRun: vi.fn(),
  saveJob: (...args: unknown[]) => saveJob(...(args as [])),
}));
vi.mock("../store/dbtStore", () => {
  const useDbtStore = (selector: (s: typeof state) => unknown) =>
    selector(state);
  useDbtStore.getState = () => state;
  return { useDbtStore };
});
vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspace: { id: "ws1" } }),
}));
vi.mock("../hooks/useIsMobile", () => ({ useIsMobile: () => false }));
vi.mock("./DbtRunHistory", () => ({ default: () => null }));

import DbtJobView from "./DbtJobView";

afterEach(() => cleanup());
beforeEach(() => saveJob.mockClear());

function openEdit() {
  render(<DbtJobView projectId="p1" jobId="j1" autoEdit />);
  const name = screen.getByLabelText("Job name") as HTMLInputElement;
  const save = screen.getByRole("button", {
    name: "Save job",
  }) as HTMLButtonElement;
  const type = (value: string) => fireEvent.change(name, { target: { value } });
  return { name, save, type };
}

describe("the job Edit form's name field", () => {
  it("a name past 128 characters, control characters, an invisible-only name: the reason inline, Save disabled, nothing sent", () => {
    const { name, save, type } = openEdit();
    expect(name.value).toBe("Nightly");
    const refused: Array<[string, string | RegExp]> = [
      ["x".repeat(129), "The name is longer than 128 characters."],
      ["a tab\there", /cannot contain line breaks/],
      ["​​", "The name cannot be empty."],
    ];
    for (const [value, reason] of refused) {
      type(value);
      expect(screen.getByText(reason)).toBeTruthy();
      expect(save.disabled).toBe(true);
      fireEvent.click(save);
    }
    expect(saveJob).not.toHaveBeenCalled();
  });

  it("an empty name says what it will be saved as, and is saved as that", async () => {
    const { save, type } = openEdit();
    expect(screen.queryByText('Saved as "Untitled job".')).toBeNull();
    type("   ");
    expect(screen.getByText('Saved as "Untitled job".')).toBeTruthy();
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await vi.waitFor(() => expect(saveJob).toHaveBeenCalled());
    expect(saveJob.mock.calls[0]).toMatchObject([
      "ws1",
      "p1",
      { name: "Untitled job" },
      "j1",
    ]);
  });

  it("a valid name is saved NFC-normalised", async () => {
    const { save, type } = openEdit();
    type("  Café build ");
    expect(save.disabled).toBe(false);
    fireEvent.click(save);
    await vi.waitFor(() => expect(saveJob).toHaveBeenCalled());
    expect(saveJob.mock.calls[0]).toMatchObject([
      "ws1",
      "p1",
      { name: "Café build" },
      "j1",
    ]);
  });
});

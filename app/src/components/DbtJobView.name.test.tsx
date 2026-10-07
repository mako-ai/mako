// @vitest-environment jsdom
/**
 * The job Edit form is the job's rename path in the editor: its name field
 * refuses, as it is typed, what the server would (browser pass shots7/s7-21:
 * 129 characters, no inline error, Save enabled, PATCH sent, 400 banner
 * after). Same rules and words as the server (lib/object-name-rules.ts,
 * pinned by api/src/rename/scenarios/name-rules-parity.test.ts).
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
  saveJob,
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
  const save = screen.getByRole("button", { name: "Save job" });
  return { name, save: save as HTMLButtonElement };
}

describe("the job Edit form's name field", () => {
  it("129 characters: the server's reason inline, Save disabled, Enter and click send nothing", () => {
    const { name, save } = openEdit();
    expect(name.value).toBe("Nightly");
    fireEvent.change(name, { target: { value: "x".repeat(129) } });
    expect(
      screen.getByText("The name is longer than 128 characters."),
    ).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.keyDown(name, { key: "Enter" });
    fireEvent.click(save);
    expect(saveJob).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "x".repeat(128) } });
    expect(
      screen.queryByText("The name is longer than 128 characters."),
    ).toBeNull();
    expect(save.disabled).toBe(false);
  });

  it("control characters and an invisible-only name are refused with the reason", () => {
    const { name, save } = openEdit();
    fireEvent.change(name, { target: { value: "a\u0007b" } });
    expect(
      screen.getByText(
        "The name cannot contain line breaks, tabs or other control characters.",
      ),
    ).toBeTruthy();
    expect(save.disabled).toBe(true);
    fireEvent.change(name, { target: { value: "\u200B" } });
    expect(screen.getByText("The name cannot be empty.")).toBeTruthy();
    expect(save.disabled).toBe(true);
  });

  it("a valid name is saved NFC-normalised", async () => {
    const { name, save } = openEdit();
    fireEvent.change(name, { target: { value: "  Cafe\u0301 build " } });
    fireEvent.click(save);
    await Promise.resolve();
    expect(saveJob).toHaveBeenCalledWith(
      "ws1",
      "p1",
      expect.objectContaining({ name: "Caf\u00E9 build" }),
      "j1",
    );
  });
});

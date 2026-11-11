// @vitest-environment jsdom
/**
 * The Rename dialog refuses, as it is typed, what the server would refuse
 * about a name: the reason shown in the server's words, Rename disabled,
 * Enter and click sending nothing.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  cleanup,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";

const renameObject = vi.hoisted(() => vi.fn());
vi.mock("../lib/object-links", () => ({ renameObject }));

import {
  RenameObjectDialog,
  type RenameObjectDialogTarget,
} from "./RenameObjectDialog";

const onRenamed = vi.fn();
const onClose = vi.fn();
afterEach(() => cleanup());
beforeEach(() => vi.clearAllMocks());

function open(kind: RenameObjectDialogTarget["kind"] = "flow") {
  render(
    <RenameObjectDialog
      workspaceId="ws1"
      target={{
        kind,
        ref: "id1",
        title: "Nightly",
        slug: "nightly",
        others: [{ slug: "hourly", title: "Hourly sync" }],
      }}
      onClose={onClose}
      onRenamed={onRenamed}
    />,
  );
  const name = screen.getByLabelText("Name") as HTMLInputElement;
  const file = screen.getByLabelText("File name") as HTMLInputElement;
  const button = screen.getByRole("button", {
    name: "Rename",
  }) as HTMLButtonElement;
  const type = (input: HTMLInputElement, value: string) =>
    fireEvent.change(input, { target: { value } });
  /** Shown, the button off, and neither Enter nor a click sends anything. */
  const expectRefused = (input: HTMLInputElement, reason: string | RegExp) => {
    expect(screen.getByText(reason)).toBeTruthy();
    expect(button.disabled).toBe(true);
    fireEvent.keyDown(input, { key: "Enter" });
    fireEvent.click(button);
    expect(renameObject).not.toHaveBeenCalled();
  };
  return { name, file, button, type, expectRefused };
}

describe("RenameObjectDialog", () => {
  it("nothing changed: nothing to send", () => {
    const { name, button } = open();
    expect(button.disabled).toBe(true);
    fireEvent.keyDown(name, { key: "Enter" });
    expect(renameObject).not.toHaveBeenCalled();
  });

  it("a name past the cap: 200 for a flow, 128 for a dbt job", () => {
    const flow = open("flow");
    flow.type(flow.name, "x".repeat(200));
    expect(flow.button.disabled).toBe(false);
    flow.type(flow.name, "x".repeat(201));
    flow.expectRefused(flow.name, "The name is longer than 200 characters.");
    cleanup();
    const job = open("dbt_job");
    job.type(job.name, "x".repeat(129));
    job.expectRefused(job.name, "The name is longer than 128 characters.");
  });

  it("control characters and an invisible-only name", () => {
    const { name, type, expectRefused } = open();
    type(name, "a tab\there");
    expectRefused(name, /cannot contain line breaks/);
    type(name, "​​");
    expectRefused(name, "The name cannot be empty.");
  });

  it("a file name that is not a slug, a Windows device name, an id lookalike", () => {
    const { file, type, expectRefused } = open();
    type(file, "Not A Slug");
    expectRefused(file, /is not a valid file name/);
    type(file, "con");
    expectRefused(file, /device name Windows reserves/);
    type(file, "0123456789abcdef01234567");
    expectRefused(file, /looks like an object id/);
  });

  it("a file name another flow or job in the list has: refused in the server's words", () => {
    const flow = open("flow");
    flow.type(flow.file, "hourly");
    flow.expectRefused(
      flow.file,
      '"hourly" is already the file name of flow "Hourly sync".',
    );
    expect(screen.queryByText(/moves to/)).toBeNull();
    flow.type(flow.file, "hourly-2");
    expect(flow.button.disabled).toBe(false);
    cleanup();
    const job = open("dbt_job");
    job.type(job.file, " hourly ");
    job.expectRefused(
      job.file,
      '"hourly" is already the file name of dbt job "Hourly sync".',
    );
  });

  it("sends only what changed, the name NFC-normalised; the server's refusal is shown as it is, until a field is edited", async () => {
    const { name, file, button, type } = open();
    type(name, "  Café nightly ");
    type(file, "cafe-nightly");
    renameObject.mockRejectedValueOnce(
      new Error('"cafe-nightly" is already the file name of flow "Other".'),
    );
    fireEvent.click(button);
    await waitFor(() =>
      expect(
        screen.getByText(
          '"cafe-nightly" is already the file name of flow "Other".',
        ),
      ).toBeTruthy(),
    );
    expect(renameObject).toHaveBeenCalledWith("ws1", "flow", {
      ref: "id1",
      title: "Café nightly",
      slug: "cafe-nightly",
    });
    expect(onRenamed).not.toHaveBeenCalled();

    // The refusal was about what was typed then: editing clears it.
    type(file, "nightly");
    expect(screen.queryByText(/is already the file name/)).toBeNull();
    const result = { id: "id1", after: { title: "Café nightly" } };
    renameObject.mockResolvedValueOnce(result);
    fireEvent.keyDown(name, { key: "Enter" });
    await waitFor(() => expect(onRenamed).toHaveBeenCalledWith(result));
    expect(renameObject).toHaveBeenLastCalledWith("ws1", "flow", {
      ref: "id1",
      title: "Café nightly",
    });
    expect(onClose).toHaveBeenCalled();
  });
});

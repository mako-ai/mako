// @vitest-environment jsdom
/**
 * The rename dialog refuses, as it is typed, what the server would refuse —
 * in the server's words — and never sends it (browser pass: a 201-character
 * flow name was accepted and refused only after submit). Rules:
 * lib/object-name-rules.ts, pinned to the server's by
 * api/src/rename/scenarios/name-rules-parity.test.ts.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";

const renameObject = vi.hoisted(() => vi.fn());
vi.mock("../lib/object-links", () => ({ renameObject }));

import { RenameObjectDialog } from "./RenameObjectDialog";

afterEach(() => cleanup());
beforeEach(() => renameObject.mockReset());

function open(kind: "flow" | "dbt_job") {
  render(
    <RenameObjectDialog
      workspaceId="ws1"
      target={{ kind, ref: "id1", title: "Nightly", slug: "nightly" }}
      onClose={() => undefined}
      onRenamed={() => undefined}
    />,
  );
  const [name, file] = screen.getAllByRole("textbox") as HTMLInputElement[];
  const button = screen.getByRole("button", { name: "Rename" });
  return { name, file, button };
}

describe("RenameObjectDialog validates as you type", () => {
  it("a flow name past 200 characters: the reason shown, Rename disabled, nothing sent", () => {
    const { name, button } = open("flow");
    fireEvent.change(name, { target: { value: "x".repeat(201) } });
    expect(
      screen.getByText("The name is longer than 200 characters."),
    ).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.keyDown(name, { key: "Enter" });
    expect(renameObject).not.toHaveBeenCalled();
    fireEvent.change(name, { target: { value: "x".repeat(200) } });
    expect(
      screen.queryByText("The name is longer than 200 characters."),
    ).toBeNull();
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("a dbt job's cap is 128", () => {
    const { name, button } = open("dbt_job");
    fireEvent.change(name, { target: { value: "x".repeat(129) } });
    expect(
      screen.getByText("The name is longer than 128 characters."),
    ).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("control and invisible-only names are refused with the reason", () => {
    const { name, button } = open("flow");
    fireEvent.change(name, { target: { value: "a\tb" } });
    expect(
      screen.getByText(
        "The name cannot contain line breaks, tabs or other control characters.",
      ),
    ).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
    fireEvent.change(name, { target: { value: "\u200B\u200B" } });
    expect(screen.getByText("The name cannot be empty.")).toBeTruthy();
    expect((button as HTMLButtonElement).disabled).toBe(true);
  });

  it("file names: not a slug, a Windows device name, an id lookalike", () => {
    const { file, button } = open("flow");
    for (const [value, reason] of [
      ["Bad Name", /is not a valid file name/],
      ["con", /device name Windows reserves/],
      ["0123456789abcdef01234567", /looks like an object id/],
    ] as const) {
      fireEvent.change(file, { target: { value } });
      expect(screen.getByText(reason)).toBeTruthy();
      expect((button as HTMLButtonElement).disabled).toBe(true);
    }
    fireEvent.change(file, { target: { value: "nightly-prod" } });
    expect((button as HTMLButtonElement).disabled).toBe(false);
  });

  it("a valid change is sent, NFC-normalised", async () => {
    renameObject.mockResolvedValue({ id: "id1" });
    const { name, button } = open("flow");
    fireEvent.change(name, { target: { value: "  Cafe\u0301  " } });
    fireEvent.click(button);
    await Promise.resolve();
    expect(renameObject).toHaveBeenCalledWith("ws1", "flow", {
      ref: "id1",
      title: "Caf\u00E9",
    });
  });
});

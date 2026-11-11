// @vitest-environment jsdom
/**
 * Renaming a skill from the Skills panel: by id, with the server's refusal
 * kept in the dialog, and the old names shown on the row afterwards.
 */
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const links = vi.hoisted(() => ({ renameObject: vi.fn() }));
vi.mock("../lib/object-links", () => links);
vi.mock("../contexts/workspace-context", () => ({
  useWorkspace: () => ({ currentWorkspace: { id: "ws1" } }),
}));
vi.mock("./ConfirmDialog", () => ({ useConfirm: () => vi.fn() }));

import { SkillsSection } from "./SkillsSection";

const skill = (name: string, aliases: string[] = []) => ({
  id: `id-${name}`,
  name,
  path: `skills/${name}/SKILL.md`,
  loadWhen: "when asked",
  bodyPreview: "Body.",
  entities: [],
  suppressed: false,
  pinned: false,
  aliases,
  definitionInvalid: null,
});
let listed = [skill("mrr_walkthrough")];

beforeEach(() => {
  listed = [skill("mrr_walkthrough")];
  links.renameObject.mockReset();
  vi.stubGlobal(
    "fetch",
    vi.fn(async () => ({
      ok: true,
      status: 200,
      json: async () => ({ success: true, skills: listed }),
    })),
  );
});
afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
});

async function openRename() {
  render(<SkillsSection />);
  fireEvent.click(await screen.findByLabelText("rename skill"));
  const input = screen.getByLabelText("New name") as HTMLInputElement;
  const button = screen.getByRole("button", { name: "Rename" });
  return { input, button: button as HTMLButtonElement };
}

describe("renaming a skill", () => {
  it("is prefilled, renames by id, and then shows the old name on the row", async () => {
    const { input, button } = await openRename();
    expect(input.value).toBe("mrr_walkthrough");
    expect(button.disabled).toBe(true);
    links.renameObject.mockImplementation(async () => {
      listed = [skill("mrr-fr", ["mrr_walkthrough"])];
      return {};
    });
    fireEvent.change(input, { target: { value: " mrr-fr " } });
    fireEvent.click(button);
    expect(await screen.findByText(/Previously:/)).toBeTruthy();
    expect(links.renameObject).toHaveBeenCalledWith("ws1", "skill", {
      ref: "id-mrr_walkthrough",
      slug: "mrr-fr",
    });
    // The dialog closes (after its exit transition).
    await vi.waitFor(() =>
      expect(screen.queryByLabelText("New name")).toBeNull(),
    );
  });

  it("keeps the dialog open with the server's words when the rename is refused", async () => {
    const { input, button } = await openRename();
    links.renameObject.mockRejectedValue(
      new Error('A skill named "other" already exists.'),
    );
    fireEvent.change(input, { target: { value: "other" } });
    fireEvent.click(button);
    expect(
      await screen.findByText('A skill named "other" already exists.'),
    ).toBeTruthy();
    expect((screen.getByLabelText("New name") as HTMLInputElement).value).toBe(
      "other",
    );
  });

  it("refuses a name as it is typed, in the shared rule's words, and sends nothing", async () => {
    const { input, button } = await openRename();
    const shape =
      "A skill name is lowercase a-z, 0-9, '-' and '_', starting with a letter or digit (it is the skill's folder name).";
    for (const [typed, said] of [
      ["Bad Name", shape],
      ["-flag", shape],
      ["", "The name cannot be empty."],
      ["x".repeat(81), "The name is longer than 80 characters."],
      ["con", /a device name Windows reserves/],
      ["507f1f77bcf86cd799439011", /looks like an object id/],
    ] as const) {
      fireEvent.change(input, { target: { value: typed } });
      expect(screen.getByText(said)).toBeTruthy();
      expect([typed, button.disabled]).toEqual([typed, true]);
      fireEvent.keyDown(input, { key: "Enter" });
    }
    expect(links.renameObject).not.toHaveBeenCalled();
    // Its own name is nothing to do; a good name enables Rename, and a
    // refusal from the server clears as soon as the name is edited.
    fireEvent.change(input, { target: { value: "mrr_walkthrough" } });
    expect(button.disabled).toBe(true);
    links.renameObject.mockRejectedValue(new Error("Taken."));
    fireEvent.change(input, { target: { value: "a-good_name2" } });
    expect(button.disabled).toBe(false);
    fireEvent.click(button);
    expect(await screen.findByText("Taken.")).toBeTruthy();
    fireEvent.change(input, { target: { value: "a-good_name3" } });
    expect(screen.queryByText("Taken.")).toBeNull();
  });

  it("a long name and its old names wrap inside the card, beside buttons that keep their room", async () => {
    const long = `weekly-${"revenue-".repeat(8)}report`;
    listed = [skill(long, [`${long}-old`])];
    render(<SkillsSection />);
    const title = await screen.findByText(long);
    expect(getComputedStyle(title).overflowWrap).toBe("anywhere");
    expect(getComputedStyle(title).minWidth).toBe("0px");
    const previously = screen.getByText(/Previously:/);
    expect(getComputedStyle(previously).overflowWrap).toBe("anywhere");
    const buttons = screen.getByLabelText("rename skill").closest("div");
    expect(buttons && getComputedStyle(buttons).flexShrink).toBe("0");
  });
});

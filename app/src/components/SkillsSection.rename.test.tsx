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
});

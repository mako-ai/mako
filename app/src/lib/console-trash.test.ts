import { describe, expect, it, vi } from "vitest";
import {
  consoleRestoredNotice,
  folderDeleteConfirmText,
  folderRestoredNotice,
  restoreTrashedFolder,
  trashedNotice,
  type TrashedFolder,
} from "./console-trash";

const trashed: TrashedFolder = {
  folders: [
    { id: "team", name: "Team", parentId: "parent", access: "workspace" },
    { id: "sub", name: "Sub", parentId: "team", access: "workspace" },
    { id: "deep", name: "Deep", parentId: "sub", access: "workspace" },
  ],
  consoles: [
    { id: "c1", name: "one", folderId: "team" },
    { id: "c2", name: "two", folderId: "sub" },
    { id: "c3", name: "three", folderId: "deep" },
  ],
};

function deps(options: { failFolders?: string[]; failConsoles?: string[] }) {
  const createFolder = vi.fn(async (name: string) =>
    options.failFolders?.includes(name) ? null : `new-${name}`,
  );
  const restoreConsole = vi.fn(
    async (id: string, _folderId: string | null) =>
      !options.failConsoles?.includes(id),
  );
  return { createFolder, restoreConsole };
}

describe("undoing a folder delete", () => {
  it("recreates the folder and its subfolders, parents first, and restores each console into its own", async () => {
    const d = deps({});
    const outcome = await restoreTrashedFolder(d, trashed, "parent");
    expect(d.createFolder.mock.calls).toEqual([
      ["Team", "parent", "workspace"],
      ["Sub", "new-Team", "workspace"],
      ["Deep", "new-Sub", "workspace"],
    ]);
    expect(d.restoreConsole.mock.calls).toEqual([
      ["c1", "new-Team"],
      ["c2", "new-Sub"],
      ["c3", "new-Deep"],
    ]);
    expect(outcome).toEqual({
      folderRecreated: true,
      inPlace: 3,
      atRoot: 0,
      failed: 0,
    });
    expect(folderRestoredNotice("Team", outcome, "Workspace")).toBe(
      "Restored the folder “Team” and 3 consoles in it.",
    );
  });

  it("falls back to the root, and says so, when the folder cannot be recreated", async () => {
    const d = deps({ failFolders: ["Team"] });
    const outcome = await restoreTrashedFolder(d, trashed, null);
    // No subfolder is created under a folder that is not there.
    expect(d.createFolder).toHaveBeenCalledTimes(1);
    expect(d.restoreConsole.mock.calls.map(call => call[1])).toEqual([
      null,
      null,
      null,
    ]);
    expect(outcome).toEqual({
      folderRecreated: false,
      inPlace: 0,
      atRoot: 3,
      failed: 0,
    });
    expect(folderRestoredNotice("Team", outcome, "My Consoles")).toBe(
      "The folder “Team” could not be recreated: 3 consoles restored to the root of My Consoles.",
    );
  });

  it("keeps what it can: a subfolder that fails sends its consoles to the root, a console that fails is counted", async () => {
    const d = deps({ failFolders: ["Sub"], failConsoles: ["c1"] });
    const outcome = await restoreTrashedFolder(d, trashed, null);
    expect(d.restoreConsole.mock.calls).toEqual([
      ["c1", "new-Team"],
      ["c2", null],
      ["c3", null],
    ]);
    expect(outcome).toEqual({
      folderRecreated: true,
      inPlace: 0,
      atRoot: 2,
      failed: 1,
    });
    expect(folderRestoredNotice("Team", outcome, "My Consoles")).toBe(
      "Restored the folder “Team”. 2 consoles from a subfolder that could not be recreated are at the root of My Consoles. 1 console could not be restored.",
    );
  });
});

describe("what the explorer says", () => {
  it("promises the trash and an Undo, and nothing it cannot do", () => {
    const confirm = folderDeleteConfirmText("Team");
    expect(confirm).toMatch(/moved to the trash/);
    expect(confirm).toMatch(/undo this right after/);
    expect(confirm).not.toMatch(/permanent|restore later|from the trash/i);
  });

  it("names what went to the trash, and under which name a console came back", () => {
    expect(trashedNotice("report")).toBe("Moved “report” to trash");
    expect(trashedNotice("Team", trashed)).toBe(
      "Deleted the folder “Team” and moved 3 consoles to trash",
    );
    expect(trashedNotice("Empty", { folders: [], consoles: [] })).toBe(
      "Deleted the empty folder “Empty”",
    );
    expect(consoleRestoredNotice("a", "a")).toBe("Restored “a”");
    expect(consoleRestoredNotice("a", "a (2)")).toBe(
      "Restored as “a (2)”: the name “a” was taken meanwhile",
    );
  });
});

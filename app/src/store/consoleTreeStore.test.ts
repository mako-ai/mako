import { beforeEach, describe, expect, it } from "vitest";
import { useConsoleTreeStore, type ConsoleEntry } from "./consoleTreeStore";

const WORKSPACE_ID = "workspace-1";

function folderNode(): ConsoleEntry {
  return {
    id: "folder-1",
    name: "Folder",
    path: "Folder",
    isDirectory: true,
    children: [],
  };
}

describe("consoleTreeStore", () => {
  beforeEach(() => {
    const myConsoles = [folderNode()];
    useConsoleTreeStore.setState({
      myConsoles: { [WORKSPACE_ID]: myConsoles },
      sharedWithWorkspace: { [WORKSPACE_ID]: [] },
      trees: { [WORKSPACE_ID]: myConsoles },
      loading: {},
      error: {},
      searchQuery: "",
      searchResults: [],
      searchLoading: false,
    });
  });

  it("adds slash-containing console names at root without splitting folders", () => {
    useConsoleTreeStore
      .getState()
      .addConsole(WORKSPACE_ID, "finance/revenue", "console-1");

    const tree = useConsoleTreeStore.getState().myConsoles[WORKSPACE_ID];
    const added = tree.find(node => node.id === "console-1");

    expect(added).toMatchObject({
      name: "finance/revenue",
      path: "finance/revenue",
      isDirectory: false,
    });
    expect(tree.find(node => node.name === "finance")).toBeUndefined();
  });

  it("uses folder ids for placement without parsing slashes from names", () => {
    useConsoleTreeStore
      .getState()
      .addConsole(WORKSPACE_ID, "north/america", "console-2", "folder-1");

    const folder = useConsoleTreeStore
      .getState()
      .myConsoles[WORKSPACE_ID].find(node => node.id === "folder-1");

    expect(folder?.children).toEqual([
      expect.objectContaining({
        id: "console-2",
        name: "north/america",
        path: "north/america",
      }),
    ]);
  });
});

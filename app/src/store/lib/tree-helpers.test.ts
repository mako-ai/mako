import { describe, expect, it } from "vitest";
import {
  countItems,
  filterTree,
  insertAlphabetically,
  namesTrailOf,
  removeById,
  type ManagedTreeNode,
} from "./tree-helpers";

interface TestNode extends ManagedTreeNode {
  id: string;
  children?: TestNode[];
}

describe("tree-helpers", () => {
  it("keeps folders before files when inserting alphabetically", () => {
    const nodes: TestNode[] = [
      { id: "file-b", name: "b.sql", isDirectory: false },
      { id: "file-c", name: "c.sql", isDirectory: false },
    ];

    insertAlphabetically(nodes, {
      id: "folder-a",
      name: "Archive",
      isDirectory: true,
      children: [],
    });
    insertAlphabetically(nodes, {
      id: "file-a",
      name: "a.sql",
      isDirectory: false,
    });

    expect(nodes.map(node => node.name)).toEqual([
      "Archive",
      "a.sql",
      "b.sql",
      "c.sql",
    ]);
  });

  it("filters matching folders without needing child matches", () => {
    const nodes: TestNode[] = [
      {
        id: "folder-1",
        name: "Dashboards",
        isDirectory: true,
        children: [{ id: "file-1", name: "Sales", isDirectory: false }],
      },
    ];

    expect(filterTree(nodes, "dash")).toEqual([
      {
        id: "folder-1",
        name: "Dashboards",
        isDirectory: true,
        children: [],
      },
    ]);
  });

  it("can require descendant matches when filtering folders", () => {
    const nodes: TestNode[] = [
      {
        id: "folder-1",
        name: "Dashboards",
        isDirectory: true,
        children: [{ id: "file-1", name: "Sales", isDirectory: false }],
      },
    ];

    expect(
      filterTree(nodes, "dash", { includeMatchingFolders: false }),
    ).toEqual([]);
    expect(
      filterTree(nodes, "sale", { includeMatchingFolders: false }),
    ).toEqual([
      {
        id: "folder-1",
        name: "Dashboards",
        isDirectory: true,
        children: [{ id: "file-1", name: "Sales", isDirectory: false }],
      },
    ]);
  });

  it("removes a nested node by id", () => {
    const nodes: TestNode[] = [
      {
        id: "folder-1",
        name: "Folder",
        isDirectory: true,
        children: [{ id: "file-1", name: "Query", isDirectory: false }],
      },
    ];

    const removed = removeById(nodes, "file-1");

    expect(removed?.name).toBe("Query");
    expect(nodes[0].children).toEqual([]);
  });

  it("counts only non-directory items", () => {
    const nodes: TestNode[] = [
      {
        id: "folder-1",
        name: "Folder",
        isDirectory: true,
        children: [
          { id: "file-1", name: "One", isDirectory: false },
          { id: "file-2", name: "Two", isDirectory: false },
        ],
      },
      { id: "file-3", name: "Three", isDirectory: false },
    ];

    expect(countItems(nodes)).toBe(3);
  });
});

describe("namesTrailOf — a folder's trail from the tree as it is now", () => {
  it("reads current names, never a stale stored path", () => {
    const nodes = [
      {
        id: "f",
        name: "Fold2", // renamed inline from "New Folder"…
        path: "New Folder", // …whose stored path was not
        isDirectory: true,
        children: [
          {
            id: "g",
            name: "Sub",
            path: "New Folder/Sub",
            isDirectory: true,
            children: [],
          },
        ],
      },
    ] as unknown as TestNode[];
    expect(namesTrailOf(nodes, "f")).toEqual(["Fold2"]);
    expect(namesTrailOf(nodes, "g")).toEqual(["Fold2", "Sub"]);
    expect(namesTrailOf(nodes, "nope")).toBeNull();
  });
});

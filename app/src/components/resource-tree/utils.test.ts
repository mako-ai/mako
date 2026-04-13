import { describe, expect, it } from "vitest";
import {
  findAncestorPaths,
  findNodeInSections,
  flattenVisibleNodeIds,
  getFolderDropTargetId,
  resolveTreeDropTarget,
  type ResourceTreeLikeNode,
  type ResourceTreeLikeSection,
} from "./utils";

interface TestNode extends ResourceTreeLikeNode {
  name: string;
  children?: TestNode[];
}

const sections: ResourceTreeLikeSection<TestNode>[] = [
  {
    key: "my",
    droppableId: "__section_my",
    defaultAccess: "private",
    nodes: [
      {
        id: "folder-a",
        name: "Folder A",
        path: "Folder A",
        isDirectory: true,
        children: [
          {
            id: "folder-b",
            name: "Folder B",
            path: "Folder A/Folder B",
            isDirectory: true,
            children: [
              {
                id: "file-1",
                name: "Console 1",
                path: "Folder A/Folder B/Console 1",
                isDirectory: false,
              },
            ],
          },
        ],
      },
    ],
  },
  {
    key: "workspace",
    droppableId: "__section_workspace",
    defaultAccess: "workspace",
    nodes: [
      {
        id: "file-2",
        name: "Workspace Console",
        path: "Workspace Console",
        isDirectory: false,
      },
    ],
  },
];

describe("resource-tree utils", () => {
  it("finds a node and its section", () => {
    expect(findNodeInSections(sections, "file-2")).toEqual({
      node: sections[1].nodes[0],
      sectionKey: "workspace",
    });
  });

  it("returns ancestor folder paths for a nested node", () => {
    expect(
      findAncestorPaths(sections[0].nodes, "file-1", [], node => node.path),
    ).toEqual(["Folder A", "Folder A/Folder B"]);
  });

  it("flattens only visible nodes", () => {
    const visible = flattenVisibleNodeIds(sections, {
      showFiles: true,
      isFolderExpanded: path => path === "Folder A",
      sectionExpanded: { my: true, workspace: false },
      getExpansionKey: node => node.path,
    });

    expect(visible).toEqual(["folder-a", "folder-b"]);
  });

  it("resolves drops into sections and folders", () => {
    expect(resolveTreeDropTarget(sections, "__section_workspace")).toEqual({
      kind: "section",
      targetFolderId: null,
      sectionKey: "workspace",
      access: "workspace",
    });

    expect(
      resolveTreeDropTarget(sections, getFolderDropTargetId("folder-b")),
    ).toEqual({
      kind: "folder",
      targetFolderId: "folder-b",
      sectionKey: "my",
    });

    expect(resolveTreeDropTarget(sections, "folder-a")).toEqual({
      kind: "folder",
      targetFolderId: "folder-a",
      sectionKey: "my",
    });
  });
});

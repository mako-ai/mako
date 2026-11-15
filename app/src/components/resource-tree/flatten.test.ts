import { describe, expect, it } from "vitest";
import {
  ancestorFolderIds,
  computeStickyScopes,
  flattenTreeRows,
  type FlatRow,
} from "./flatten";
import type { ResourceTreeNode, ResourceTreeSection } from "./types";

const file = (id: string): ResourceTreeNode => ({
  id,
  name: id,
  path: id,
  isDirectory: false,
});
const dir = (id: string, children?: ResourceTreeNode[]): ResourceTreeNode => ({
  id,
  name: id,
  path: id,
  isDirectory: true,
  children,
});

const tree: ResourceTreeSection[] = [
  {
    key: "my",
    label: "My",
    droppableId: "__section_my",
    nodes: [dir("a", [file("a1"), dir("b", [file("b1")])]), file("top")],
  },
  { key: "ws", label: "Workspace", nodes: [] },
];

const flatten = (
  over: Partial<Parameters<typeof flattenTreeRows>[1]> = {},
  sections = tree,
) =>
  flattenTreeRows(sections, {
    showFiles: true,
    enableDragDrop: true,
    sectionExpanded: {},
    isNodeExpanded: () => true,
    ...over,
  });

const describeRow = (row: FlatRow) =>
  row.kind === "folder" || row.kind === "file"
    ? `${row.kind}:${row.node.id}@${row.depth}`
    : row.kind === "section-header" || row.kind === "section-empty"
      ? `${row.kind}:${row.section.key}`
      : row.kind;

describe("flattenTreeRows", () => {
  it("lists rows in display order with depths", () => {
    expect(flatten().map(describeRow)).toEqual([
      "section-header:my",
      "folder:a@1",
      "file:a1@2",
      "folder:b@2",
      "file:b1@3",
      "file:top@1",
      "section-header:ws",
      "section-empty:ws",
      "spacer",
    ]);
  });

  it("tracks scopes, parents and drop targets", () => {
    const rows = flatten();
    expect(rows[0]).toMatchObject({ kind: "section-header", scopeEnd: 5 });
    expect(rows[1]).toMatchObject({ kind: "folder", scopeEnd: 4, parent: 0 });
    expect(rows[3]).toMatchObject({ kind: "folder", scopeEnd: 4, parent: 1 });
    expect(rows[2]).toMatchObject({ dropTarget: "__folder_content_a" });
    expect(rows[5]).toMatchObject({ dropTarget: "__section_my", parent: 0 });
    expect(ancestorFolderIds(rows, 4)).toEqual(["a", "b"]);
  });

  it("skips collapsed folders and sections", () => {
    const rows = flatten({
      isNodeExpanded: node => node.id !== "a",
      sectionExpanded: { ws: false },
    });
    expect(rows.map(describeRow)).toEqual([
      "section-header:my",
      "folder:a@1",
      "file:top@1",
      "section-header:ws",
      "spacer",
    ]);
    expect(rows[1]).toMatchObject({ isExpanded: false, scopeEnd: 1 });
  });

  it("shows skeletons while loading and Empty for no children", () => {
    const sections: ResourceTreeSection[] = [
      {
        key: "s",
        label: "S",
        hideSectionHeader: true,
        nodes: [dir("lazy"), dir("none", [])],
      },
    ];
    expect(flatten({}, sections).map(describeRow)).toEqual([
      "folder:lazy@0",
      "skeleton",
      "skeleton",
      "skeleton",
      "folder:none@0",
      "empty",
      "spacer",
    ]);
    expect(
      flatten({ showFiles: false, enableDragDrop: false }).every(
        row => row.kind !== "file",
      ),
    ).toBe(true);
  });
});

describe("computeStickyScopes", () => {
  const rows = flatten();
  const item = (index: number) => ({ index, offset: index * 24, size: 24 });

  it("spans each rendered header to the end of its scope", () => {
    const rendered = rows.map((_, i) => item(i));
    const scopes = computeStickyScopes(rows, rendered, rows.length * 24);
    expect(scopes).toEqual([
      { index: 0, top: 0, height: 6 * 24 },
      { index: 1, top: 24, height: 4 * 24 },
      { index: 3, top: 72, height: 2 * 24 },
      { index: 6, top: 144, height: 2 * 24 },
    ]);
  });

  it("keeps enclosing headers that were virtualized away", () => {
    // Only rows 3..4 rendered: section + folder a enclose them from above.
    const scopes = computeStickyScopes(rows, [item(3), item(4)], 1000);
    expect(scopes.map(s => s.index)).toEqual([0, 1, 3]);
    expect(scopes[0]).toEqual({ index: 0, top: 0, height: 1000 });
    expect(scopes[1]).toEqual({ index: 1, top: 0, height: 120 });
  });

  it("returns nothing before anything rendered", () => {
    expect(computeStickyScopes(rows, [], 0)).toEqual([]);
  });
});

import { describe, expect, it } from "vitest";
import type { Favourite } from "../../store/favouritesStore";
import {
  buildStarredSection,
  entityIdFromStarredRow,
  favouriteIdFromFolderRow,
  isStarredRow,
  realEntityId,
  starredFolderId,
  starredRowId,
} from "./starred-section";

const rows: Favourite[] = [
  { id: "f1", parentId: null, type: "folder", title: "Daily", position: 1 },
  {
    id: "i1",
    parentId: null,
    type: "item",
    kind: "app",
    refId: "a1",
    position: 0,
  },
  {
    id: "i2",
    parentId: "f1",
    type: "item",
    kind: "app",
    refId: "a2",
    position: 1,
  },
  {
    id: "i3",
    parentId: "f1",
    type: "item",
    kind: "app",
    refId: "gone",
    position: 0,
  },
  {
    id: "i4",
    parentId: "f1",
    type: "item",
    kind: "notebook",
    refId: "n1",
    position: 2,
  },
  { id: "f2", parentId: "f1", type: "folder", title: "Sub", position: 3 },
];

const resolve = (refId: string) =>
  refId === "gone"
    ? undefined
    : { name: `App ${refId}`, path: `apps/${refId}` };

describe("buildStarredSection", () => {
  it("builds a tree of this kind's items inside the user's folders, in position order", () => {
    const [section] = buildStarredSection(rows, "app", resolve);
    expect(section.key).toBe("starred");
    expect(section.nodes.map(n => n.id)).toEqual([
      starredRowId("a1"),
      starredFolderId("f1"),
    ]);
    const daily = section.nodes[1];
    expect(daily.isDirectory).toBe(true);
    expect(daily.name).toBe("Daily");
    // The unresolvable item and the notebook are dropped; the subfolder stays.
    expect(daily.children?.map(n => n.id)).toEqual([
      starredRowId("a2"),
      starredFolderId("f2"),
    ]);
    // No droppable id unless asked: a drop must never read as a sharing change.
    expect(section.droppableId).toBeUndefined();
    expect(
      buildStarredSection(rows, "app", resolve, { droppable: true })[0]
        .droppableId,
    ).toBe("__section_starred");
  });

  it("renders nothing when there are no folders and no resolvable items", () => {
    expect(buildStarredSection([], "app", resolve)).toEqual([]);
    expect(buildStarredSection(rows, "dashboard", resolve)).toHaveLength(1);
    expect(
      buildStarredSection(
        rows.filter(r => r.type === "item"),
        "dashboard",
        resolve,
      ),
    ).toEqual([]);
  });

  it("tells pinned rows and folders from real ones", () => {
    expect(entityIdFromStarredRow(starredRowId("a1"))).toBe("a1");
    expect(entityIdFromStarredRow("a1")).toBeNull();
    expect(favouriteIdFromFolderRow(starredFolderId("f1"))).toBe("f1");
    expect(favouriteIdFromFolderRow(starredRowId("a1"))).toBeNull();
    expect(realEntityId(starredRowId("a1"))).toBe("a1");
    expect(realEntityId("a1")).toBe("a1");
    expect(isStarredRow(starredFolderId("f1"))).toBe(true);
    expect(isStarredRow("__folder__apps/Sales")).toBe(false);
  });
});

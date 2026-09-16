import { describe, expect, it } from "vitest";

import {
  FOLDERS_SECTION_KEY,
  STARRED_SECTION_KEY,
  buildPersonalSections,
  folderOfKey,
  folderedKeys,
  parsePersonalNodeId,
  personalFolderNodeId,
  personalItemNodeId,
  starredKeys,
} from "./personal-sections";
import type { PersonalFolder } from "../../store/personalFoldersStore";

const folder = (over: Partial<PersonalFolder> = {}): PersonalFolder => ({
  id: "f1",
  kind: "app",
  name: "Daily",
  items: [],
  ...over,
});

const starredList = (items: string[]): PersonalFolder => ({
  id: "s1",
  kind: "app",
  name: "Starred",
  items,
  system: "starred",
});

const APPS = [
  { id: "a1", title: "Billing", slug: "billing" },
  { id: "a2", title: "Churn Radar", slug: "churn" },
  { id: "a3", title: "No Slug" },
];

describe("buildPersonalSections", () => {
  it("renders nothing when the user has no folders and nothing starred", () => {
    expect(buildPersonalSections([], APPS)).toEqual([]);
    // A Starred list that exists but is empty is not a section either.
    expect(buildPersonalSections([starredList([])], APPS)).toEqual([]);
  });

  it("puts Starred first, as a flat list of shortcuts", () => {
    const sections = buildPersonalSections(
      [folder({ items: ["churn"] }), starredList(["billing"])],
      APPS,
    );
    expect(sections.map(s => s.key)).toEqual([
      STARRED_SECTION_KEY,
      FOLDERS_SECTION_KEY,
    ]);
    const [star] = sections;
    expect(star.nodes.map(n => n.name)).toEqual(["Billing"]);
    expect(star.nodes[0].isDirectory).toBe(false);
    // Flat: the star row's id points at the Starred list itself.
    expect(parsePersonalNodeId(star.nodes[0].id)).toEqual({
      kind: "personal-item",
      folderId: "s1",
      appId: "a1",
    });
  });

  it("never lists the Starred system row as one of My Folders", () => {
    const [, mine] = buildPersonalSections(
      [starredList(["billing"]), folder({ items: ["churn"] })],
      APPS,
    );
    expect(mine.key).toBe(FOLDERS_SECTION_KEY);
    expect(mine.nodes.map(n => n.name)).toEqual(["Daily"]);
  });

  it("resolves stored slugs to shortcut rows, sorted by title", () => {
    const [section] = buildPersonalSections(
      [folder({ items: ["churn", "billing"] })],
      APPS,
    );
    const node = section.nodes[0];
    expect(node.id).toBe(personalFolderNodeId("f1"));
    expect(node.isDirectory).toBe(true);
    expect(node.children?.map(c => c.name)).toEqual(["Billing", "Churn Radar"]);
    // Leaf shortcuts, so the tree never tries to load a file tree for them.
    expect(node.children?.every(c => c.isDirectory === false)).toBe(true);
  });

  it("gives folder rows children as a real array, never undefined", () => {
    const [section] = buildPersonalSections([folder()], APPS);
    // `undefined` would make ResourceTree fire onLoadChildren forever.
    expect(section.nodes[0].children).toEqual([]);
  });

  it("drops keys that no longer resolve to a visible app", () => {
    const [section] = buildPersonalSections(
      [folder({ items: ["billing", "deleted-app", "no-slug"] })],
      APPS,
    );
    expect(section.nodes[0].children?.map(c => c.name)).toEqual(["Billing"]);
  });

  it("is not a drop target, so a drop cannot be read as a sharing change", () => {
    for (const section of buildPersonalSections(
      [folder(), starredList(["billing"])],
      APPS,
    )) {
      expect(section.droppableId).toBeUndefined();
      expect(section.defaultAccess).toBeUndefined();
    }
  });

  it("keeps shortcut ids distinct from the app's home row id", () => {
    const [section] = buildPersonalSections(
      [folder({ items: ["billing"] })],
      APPS,
    );
    // Same id as the home row would make "which copy was right-clicked?"
    // unanswerable, so Remove-from-folder could not be offered.
    expect(section.nodes[0].children?.[0].id).not.toBe("a1");
  });
});

describe("folderedKeys / starredKeys / folderOfKey", () => {
  const folders = [
    starredList(["billing", "churn"]),
    folder({ id: "f1", name: "A", items: ["billing"] }),
    folder({ id: "f2", name: "B", items: ["seller"] }),
  ];

  it("a folder moves: filed keys are hidden from home; stars are not", () => {
    // Filed in a folder → hidden from its home section in this user's view.
    expect([...folderedKeys(folders)].sort()).toEqual(["billing", "seller"]);
    // Starred only → still shown at home; a star is a shortcut.
    expect(folderedKeys(folders).has("churn")).toBe(false);
    expect([...starredKeys(folders)].sort()).toEqual(["billing", "churn"]);
  });

  it("finds the one folder a key lives in", () => {
    expect(folderOfKey(folders, "seller")?.name).toBe("B");
    expect(folderOfKey(folders, "churn")).toBeUndefined();
    expect(folderOfKey(folders, undefined)).toBeUndefined();
  });
});

describe("parsePersonalNodeId", () => {
  it("returns null for app, file and directory ids", () => {
    expect(parsePersonalNodeId("a1")).toBeNull();
    expect(parsePersonalNodeId("a1::file::src/main.tsx")).toBeNull();
    expect(parsePersonalNodeId("a1::dir::src")).toBeNull();
  });

  it("round-trips a folder id", () => {
    expect(parsePersonalNodeId(personalFolderNodeId("f1"))).toEqual({
      kind: "personal-folder",
      folderId: "f1",
    });
  });

  it("round-trips a shortcut id", () => {
    expect(parsePersonalNodeId(personalItemNodeId("f1", "a1"))).toEqual({
      kind: "personal-item",
      folderId: "f1",
      appId: "a1",
    });
  });
});

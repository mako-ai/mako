import { describe, expect, it } from "vitest";

import {
  buildPersonalSections,
  parsePersonalNodeId,
  personalFolderNodeId,
  personalItemNodeId,
} from "./personal-sections";
import type { PersonalFolder } from "../../store/personalFoldersStore";

const folder = (over: Partial<PersonalFolder> = {}): PersonalFolder => ({
  id: "f1",
  kind: "app",
  name: "Daily",
  items: [],
  ...over,
});

const APPS = [
  { id: "a1", title: "Billing", slug: "billing" },
  { id: "a2", title: "Churn Radar", slug: "churn" },
  { id: "a3", title: "No Slug" },
];

describe("buildPersonalSections", () => {
  it("renders nothing when the user has no folders", () => {
    expect(buildPersonalSections([], APPS)).toEqual([]);
  });

  it("resolves stored slugs to app shortcut rows", () => {
    const [section] = buildPersonalSections(
      [folder({ items: ["churn", "billing"] })],
      APPS,
    );
    expect(section.key).toBe("my-folders");
    expect(section.nodes).toHaveLength(1);

    const node = section.nodes[0];
    expect(node.id).toBe(personalFolderNodeId("f1"));
    expect(node.isDirectory).toBe(true);
    // Sorted by title, not by stored order.
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
    const [section] = buildPersonalSections([folder()], APPS);
    expect(section.droppableId).toBeUndefined();
    expect(section.defaultAccess).toBeUndefined();
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

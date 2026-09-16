import { describe, expect, it } from "vitest";

import {
  buildPersonalSections,
  listIdFromSectionKey,
  listOfKey,
  parsePersonalNodeId,
  personalItemNodeId,
  placedKeys,
  sectionKeyForList,
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

const starred = (items: string[]): PersonalFolder => ({
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
  it("renders nothing without folders or stars", () => {
    expect(buildPersonalSections([], APPS)).toEqual([]);
    // Starred is the star button's affordance; empty it would be pure noise.
    expect(buildPersonalSections([starred([])], APPS)).toEqual([]);
  });

  it("is flat: Starred first, then one TOP-LEVEL section per folder", () => {
    const sections = buildPersonalSections(
      [
        folder({ id: "f1", name: "Marketing", items: ["churn"] }),
        starred(["billing"]),
        folder({ id: "f2", name: "Ops", items: [] }),
      ],
      APPS,
    );

    expect(sections.map(s => s.label)).toEqual(["Starred", "Marketing", "Ops"]);
    // No folder rows and no nesting — every section holds app rows directly.
    for (const section of sections) {
      expect(section.nodes.every(n => n.isDirectory === false)).toBe(true);
      expect(section.nodes.every(n => n.children === undefined)).toBe(true);
    }
    expect(sections[0].nodes.map(n => n.name)).toEqual(["Billing"]);
    expect(sections[1].nodes.map(n => n.name)).toEqual(["Churn Radar"]);
  });

  it("keeps an EMPTY folder visible, so a new folder can be dropped onto", () => {
    const [section] = buildPersonalSections([folder({ name: "Ops" })], APPS);
    expect(section.label).toBe("Ops");
    expect(section.nodes).toEqual([]);
    expect(section.droppableId).toBeTruthy();
  });

  it("makes each section a drop target but never an access bucket", () => {
    for (const section of buildPersonalSections(
      [folder({ items: ["churn"] }), starred(["billing"])],
      APPS,
    )) {
      expect(section.droppableId).toBeTruthy();
      // No defaultAccess: a drop here can never be read as a sharing change.
      expect(section.defaultAccess).toBeUndefined();
    }
  });

  it("sorts rows by title and drops keys that no longer resolve", () => {
    const [section] = buildPersonalSections(
      [folder({ items: ["churn", "deleted-app", "no-slug", "billing"] })],
      APPS,
    );
    expect(section.nodes.map(n => n.name)).toEqual(["Billing", "Churn Radar"]);
  });

  it("keeps row ids distinct from the app's home row id", () => {
    const [section] = buildPersonalSections(
      [folder({ items: ["billing"] })],
      APPS,
    );
    // A shared id would make "which copy was right-clicked?" unanswerable.
    expect(section.nodes[0].id).not.toBe("a1");
    expect(parsePersonalNodeId(section.nodes[0].id)).toEqual({
      kind: "personal-item",
      listId: "f1",
      appId: "a1",
    });
  });
});

describe("placedKeys / starredKeys / listOfKey", () => {
  const folders = [
    starred(["billing"]),
    folder({ id: "f1", name: "A", items: ["churn"] }),
    folder({ id: "f2", name: "B", items: ["seller"] }),
  ];

  it("one home per app: starred AND filed keys both leave the home sections", () => {
    expect([...placedKeys(folders)].sort()).toEqual([
      "billing",
      "churn",
      "seller",
    ]);
    expect([...starredKeys(folders)]).toEqual(["billing"]);
  });

  it("finds the one list a key lives in, Starred included", () => {
    expect(listOfKey(folders, "seller")?.name).toBe("B");
    expect(listOfKey(folders, "billing")?.system).toBe("starred");
    expect(listOfKey(folders, "unplaced")).toBeUndefined();
    expect(listOfKey(folders, undefined)).toBeUndefined();
  });
});

describe("section keys", () => {
  it("round-trips a list id", () => {
    expect(listIdFromSectionKey(sectionKeyForList("f1"))).toBe("f1");
  });

  it("returns null for the access-based sections", () => {
    for (const key of ["my", "workspace", "shared-with-me"]) {
      expect(listIdFromSectionKey(key)).toBeNull();
    }
  });
});

describe("parsePersonalNodeId", () => {
  it("returns null for app, file and directory ids", () => {
    expect(parsePersonalNodeId("a1")).toBeNull();
    expect(parsePersonalNodeId("a1::file::src/main.tsx")).toBeNull();
    expect(parsePersonalNodeId("a1::dir::src")).toBeNull();
  });

  it("returns null for a section key — sections are not nodes", () => {
    expect(parsePersonalNodeId(sectionKeyForList("f1"))).toBeNull();
  });

  it("round-trips an app row", () => {
    expect(parsePersonalNodeId(personalItemNodeId("f1", "a1"))).toEqual({
      kind: "personal-item",
      listId: "f1",
      appId: "a1",
    });
  });
});

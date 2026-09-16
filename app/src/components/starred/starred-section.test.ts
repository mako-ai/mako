import { describe, expect, it } from "vitest";

import {
  STARRED_SECTION_KEY,
  buildStarredSection,
  entityIdFromStarredRow,
  flattenLeafRows,
  realEntityId,
  starredKeys,
  starredRowId,
} from "./starred-section";
import type { PersonalFolder } from "../../store/personalFoldersStore";

const starred = (items: string[]): PersonalFolder => ({
  id: "s1",
  kind: "notebook",
  name: "Starred",
  items,
  system: "starred",
});

const NAMES: Record<string, string> = {
  n1: "Churn model",
  n2: "Attribution",
};
const resolve = (key: string) =>
  NAMES[key] ? { name: NAMES[key] } : undefined;

describe("buildStarredSection", () => {
  it("renders nothing when nothing is starred", () => {
    expect(buildStarredSection([], resolve)).toEqual([]);
    expect(buildStarredSection([starred([])], resolve)).toEqual([]);
  });

  it("builds one flat section of pinned rows, sorted by name", () => {
    const [section] = buildStarredSection([starred(["n1", "n2"])], resolve);
    expect(section.key).toBe(STARRED_SECTION_KEY);
    expect(section.label).toBe("Starred");
    expect(section.nodes.map(n => n.name)).toEqual([
      "Attribution",
      "Churn model",
    ]);
    // Flat shortcuts: nothing to expand, no lazy children.
    expect(section.nodes.every(n => n.isDirectory === false)).toBe(true);
    expect(section.nodes.every(n => n.children === undefined)).toBe(true);
  });

  it("is never a drop target or an access bucket", () => {
    const [section] = buildStarredSection([starred(["n1"])], resolve);
    expect(section.droppableId).toBeUndefined();
    expect(section.defaultAccess).toBeUndefined();
  });

  it("drops keys that no longer resolve, leaving membership alone", () => {
    const [section] = buildStarredSection(
      [starred(["n1", "deleted", "n2"])],
      resolve,
    );
    expect(section.nodes.map(n => n.name)).toEqual([
      "Attribution",
      "Churn model",
    ]);
    // The stored list is untouched — the entity may just be absent here.
    expect(starredKeys([starred(["n1", "deleted", "n2"])]).size).toBe(3);
  });

  it("carries entityType onto the pinned row when the source has one", () => {
    // Dashboards' getItemIcon keys off entityType, so a pinned row without it
    // renders with no icon.
    const [section] = buildStarredSection([starred(["n1"])], () => ({
      name: "Revenue",
      entityType: "dashboard",
    }));
    expect(section.nodes[0].entityType).toBe("dashboard");
  });

  it("omits entityType when the source has none", () => {
    const [section] = buildStarredSection([starred(["n1"])], resolve);
    expect(section.nodes[0].entityType).toBeUndefined();
  });

  it("gives the pinned row its own id, so the real row keeps the highlight", () => {
    const [section] = buildStarredSection([starred(["n1"])], resolve);
    const pinned = section.nodes[0];
    expect(pinned.id).not.toBe("n1");
    expect(entityIdFromStarredRow(pinned.id)).toBe("n1");
  });
});

describe("row id helpers", () => {
  it("round-trips a pinned row id", () => {
    expect(entityIdFromStarredRow(starredRowId("n1"))).toBe("n1");
  });

  it("returns null for an ordinary row", () => {
    expect(entityIdFromStarredRow("n1")).toBeNull();
    expect(entityIdFromStarredRow("d1::dashboard-data-source::x")).toBeNull();
  });

  it("realEntityId resolves either kind of row to the entity", () => {
    expect(realEntityId(starredRowId("n1"))).toBe("n1");
    expect(realEntityId("n1")).toBe("n1");
  });
});

describe("flattenLeafRows", () => {
  const node = (
    id: string,
    isDirectory: boolean,
    children?: unknown[],
  ): never => ({ id, name: id, path: id, isDirectory, children }) as never;

  it("collects leaves and walks through folders, at any depth", () => {
    const rows = flattenLeafRows([
      node("a", false),
      node("f1", true, [
        node("b", false),
        node("f2", true, [node("c", false)]),
      ]),
    ]);
    expect(rows.map(r => r.id)).toEqual(["a", "b", "c"]);
  });

  it("keeps no folders, and survives a folder with no children", () => {
    const rows = flattenLeafRows([node("empty", true), node("d", false)]);
    expect(rows.map(r => r.id)).toEqual(["d"]);
  });

  it("does NOT depend on entityType", () => {
    // The dashboards regression: raw store entries carry no entityType — it is
    // stamped on later, when nodes are decorated for rendering. Matching on it
    // here found nothing and the Starred section rendered empty.
    const rows = flattenLeafRows([
      node("dash-1", false),
      node("dash-2", false),
    ]);
    expect(rows.map(r => r.id)).toEqual(["dash-1", "dash-2"]);
  });
});

describe("starredKeys", () => {
  it("reads the system list and ignores ordinary folders", () => {
    const folders: PersonalFolder[] = [
      starred(["n1"]),
      { id: "f1", kind: "notebook", name: "Mine", items: ["n2"] },
    ];
    expect([...starredKeys(folders)]).toEqual(["n1"]);
  });
});

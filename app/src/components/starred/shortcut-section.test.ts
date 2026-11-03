import { describe, expect, it } from "vitest";
import {
  buildShortcutSection,
  parseShortcutRow,
  shortcutRowId,
} from "./shortcut-section";

describe("shortcut sections", () => {
  it("round-trips row ids, and leaves other ids alone", () => {
    const id = shortcutRowId("recent", "66f000000000000000000001");
    expect(parseShortcutRow(id)).toEqual({
      sectionKey: "recent",
      refId: "66f000000000000000000001",
    });
    expect(parseShortcutRow("66f000000000000000000001")).toBeNull();
    expect(parseShortcutRow("__star__x")).toBeNull();
  });

  it("keeps order, drops unresolved and duplicate ids, honours the limit", () => {
    const names: Record<string, string> = { a: "A", b: "B", c: "C" };
    const [section] = buildShortcutSection({
      key: "popular",
      label: "Popular",
      refIds: ["b", "gone", "a", "b", "c"],
      resolve: id => (names[id] ? { name: names[id] } : undefined),
      limit: 2,
    });
    expect(section.nodes.map(n => n.name)).toEqual(["B", "A"]);
    expect(section.nodes[0].id).toBe(shortcutRowId("popular", "b"));
    expect(section.nodes.every(n => !n.isDirectory)).toBe(true);
  });

  it("omits the section when nothing resolves", () => {
    expect(
      buildShortcutSection({
        key: "recent",
        label: "Recently viewed",
        refIds: ["x"],
        resolve: () => undefined,
      }),
    ).toEqual([]);
  });
});

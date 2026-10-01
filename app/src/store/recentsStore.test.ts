import { beforeEach, describe, expect, it } from "vitest";
import {
  MAX_RECENTS_PER_WORKSPACE,
  selectRecents,
  useRecentsStore,
} from "./recentsStore";

describe("recentsStore", () => {
  beforeEach(() => {
    useRecentsStore.getState().reset();
  });

  it("puts the latest activation first and dedupes by kind + id", () => {
    const s = useRecentsStore.getState();
    s.record("w1", { kind: "console", id: "c1", title: "First" });
    s.record("w1", { kind: "dashboard", id: "d1", title: "Board" });
    s.record("w1", { kind: "console", id: "c1", title: "First (renamed)" });
    const list = selectRecents("w1")(useRecentsStore.getState());
    expect(list.map(e => `${e.kind}:${e.id}`)).toEqual([
      "console:c1",
      "dashboard:d1",
    ]);
    expect(list[0].title).toBe("First (renamed)");
  });

  it("is scoped per workspace", () => {
    const s = useRecentsStore.getState();
    s.record("w1", { kind: "app", id: "a1", title: "App", slug: "app" });
    s.record("w2", { kind: "notebook", id: "n1", title: "Notes" });
    expect(selectRecents("w1")(useRecentsStore.getState())).toHaveLength(1);
    expect(selectRecents("w2")(useRecentsStore.getState())).toHaveLength(1);
    expect(selectRecents(undefined)(useRecentsStore.getState())).toEqual([]);
  });

  it("caps the list and drops the oldest", () => {
    const s = useRecentsStore.getState();
    for (let i = 0; i < MAX_RECENTS_PER_WORKSPACE + 3; i += 1) {
      s.record("w1", { kind: "console", id: `c${i}`, title: `C${i}` });
    }
    const list = selectRecents("w1")(useRecentsStore.getState());
    expect(list).toHaveLength(MAX_RECENTS_PER_WORKSPACE);
    expect(list[0].id).toBe(`c${MAX_RECENTS_PER_WORKSPACE + 2}`);
    expect(list.some(e => e.id === "c0")).toBe(false);
  });

  it("removes an entry", () => {
    const s = useRecentsStore.getState();
    s.record("w1", { kind: "console", id: "c1", title: "First" });
    s.remove("w1", "console", "c1");
    expect(selectRecents("w1")(useRecentsStore.getState())).toEqual([]);
  });
});

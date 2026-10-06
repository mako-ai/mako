import { beforeEach, describe, expect, it, vi } from "vitest";

// The store persists through zustand's `persist`, which reads the global
// `localStorage` once at module load. Node 22+ defines that global but
// leaves it `undefined` without `--localstorage-file`, so the middleware
// gets no storage and every write throws; give it an in-memory one before
// the store module is evaluated (hoisted above the imports).
vi.hoisted(() => {
  const memory = new Map<string, string>();
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => memory.get(k) ?? null,
      setItem: (k: string, v: string) => void memory.set(k, v),
      removeItem: (k: string) => void memory.delete(k),
    },
  });
});

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

  it("heals app entries by id after a rename: current title and slug, nothing else touched", () => {
    const s = useRecentsStore.getState();
    s.record("w1", { kind: "app", id: "app1", title: "Old name", slug: "old" });
    s.record("w1", { kind: "console", id: "c1", title: "Console" });
    s.record("w2", { kind: "app", id: "app1", title: "Old name", slug: "old" });
    s.healApps(
      "w1",
      new Map([
        ["app1", { title: "New name", slug: "new" }],
        ["ghost", { title: "Not listed", slug: undefined }],
      ]),
    );
    const w1 = selectRecents("w1")(useRecentsStore.getState());
    expect(w1.map(e => [e.kind, e.id, e.title, e.slug])).toEqual([
      ["console", "c1", "Console", undefined],
      ["app", "app1", "New name", "new"],
    ]);
    // Another workspace's list is its own.
    expect(selectRecents("w2")(useRecentsStore.getState())[0].slug).toBe("old");
    // An app that moved into a folder loses its slug (id-addressed now).
    s.healApps(
      "w1",
      new Map([["app1", { title: "New name", slug: undefined }]]),
    );
    expect(
      selectRecents("w1")(useRecentsStore.getState())[1].slug,
    ).toBeUndefined();
  });
});

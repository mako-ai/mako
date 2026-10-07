// @vitest-environment jsdom
/**
 * The address an app's tab and links use (`appUrlRef`), mirrored by the
 * server's `appUrlFor` (api/src/rename/handlers/app.ts): the folder name at
 * the top of the workspace tree, the id anywhere else — and the id when the
 * folder name LOOKS like an id, since every resolver (server and client)
 * reads a 24-hex `/apps/<ref>` as an id first: such a link would open
 * another app, or none.
 */
import { describe, expect, it, vi } from "vitest";

// The store persists through localStorage; some jsdom/Node pairings ship
// none, and the store must still import.
vi.hoisted(() => {
  const data = new Map<string, string>();
  const storage = {
    getItem: (k: string) => data.get(k) ?? null,
    setItem: (k: string, v: string) => void data.set(k, String(v)),
    removeItem: (k: string) => void data.delete(k),
    clear: () => data.clear(),
    key: (i: number) => [...data.keys()][i] ?? null,
    get length() {
      return data.size;
    },
  };
  Object.defineProperty(globalThis, "localStorage", {
    value: storage,
    configurable: true,
  });
});

import { appUrlRef, appUrlSlug } from "./appsStore";

const ID = "6aa30149273767efe9ee382a";

describe("appUrlRef", () => {
  it("is the slug at the top of the workspace tree, the id anywhere else", () => {
    expect(
      appUrlRef({
        id: ID,
        slug: "traffic-performance",
        path: "apps/traffic-performance",
      }),
    ).toBe("traffic-performance");
    expect(appUrlRef({ id: ID, slug: "x", path: "apps/Sales/x" })).toBe(ID);
    expect(appUrlRef({ id: ID, slug: "x", path: "users/u1/apps/x" })).toBe(ID);
  });

  it("is the id when the folder name looks like an id", () => {
    const other = "0123456789abcdef01234567";
    expect(appUrlRef({ id: ID, slug: other, path: `apps/${other}` })).toBe(ID);
    const upper = other.toUpperCase();
    expect(appUrlRef({ id: ID, slug: upper, path: `apps/${upper}` })).toBe(ID);
    expect(appUrlSlug({ id: ID, slug: other, path: `apps/${other}` })).toBe(
      undefined,
    );
  });
});

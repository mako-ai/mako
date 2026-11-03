// @vitest-environment jsdom
/**
 * Restored tabs mount on first show, not on page load.
 *
 * Reported 2026-10-22: ten app tabs open, one refresh, ten apps booted. Each
 * minted a view token, loaded its iframe, booted DuckDB-WASM and downloaded
 * its parquet, all competing with the tab on screen.
 */
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { act, cleanup, render } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useEffect } from "react";
import type { TabKind } from "../store/lib/types";
import {
  APP_TAB_MOUNT_CAP,
  isTabMounted,
  nextMountedTabs,
  useMountedTabs,
} from "./tab-mount-policy";

const app = (id: string) => ({ id, kind: "app" as TabKind });

describe("nextMountedTabs", () => {
  it("mounts nothing lazy until a tab is shown", () => {
    const tabs = [app("a"), app("b"), app("c")];
    expect(nextMountedTabs([], tabs, [])).toEqual([]);
    expect(nextMountedTabs([], tabs, [null])).toEqual([]);
    expect(nextMountedTabs([], tabs, ["b"])).toEqual(["b"]);
  });

  it("keeps a shown tab mounted after switching away", () => {
    const tabs = [app("a"), app("b")];
    const one = nextMountedTabs([], tabs, ["a"]);
    const two = nextMountedTabs(one, tabs, ["b"]);
    expect(two).toEqual(["a", "b"]);
    // Back to a: still mounted, now the most recent.
    expect(nextMountedTabs(two, tabs, ["a"])).toEqual(["b", "a"]);
  });

  it("returns the same list when nothing changed", () => {
    const tabs = [app("a"), app("b")];
    const prev = nextMountedTabs([], tabs, ["a"]);
    expect(nextMountedTabs(prev, tabs, ["a"])).toBe(prev);
  });

  it(`keeps at most ${APP_TAB_MOUNT_CAP} app tabs, evicting the least recent`, () => {
    const tabs = ["a", "b", "c", "d", "e", "f"].map(app);
    let mounted: readonly string[] = [];
    for (const id of ["a", "b", "c", "d", "e"]) {
      mounted = nextMountedTabs(mounted, tabs, [id]);
    }
    expect(mounted).toEqual(["b", "c", "d", "e"]);
    // Revisiting b refreshes it; f then evicts c, the oldest.
    mounted = nextMountedTabs(mounted, tabs, ["b"]);
    mounted = nextMountedTabs(mounted, tabs, ["f"]);
    expect(mounted).toEqual(["d", "e", "b", "f"]);
  });

  it("never evicts a visible tab, and mounts both panes of a split view", () => {
    const tabs = ["a", "b", "c", "d", "e"].map(app);
    let mounted: readonly string[] = [];
    for (const id of ["a", "b", "c"]) {
      mounted = nextMountedTabs(mounted, tabs, [id]);
    }
    mounted = nextMountedTabs(mounted, tabs, ["d", "e"]);
    expect(mounted).toEqual(["b", "c", "d", "e"]);
    expect(mounted).toContain("d");
    expect(mounted).toContain("e");
  });

  it("caps app tabs only: notebooks are lazy without a cap", () => {
    const notebooks = ["n1", "n2", "n3", "n4", "n5", "n6"].map(id => ({
      id,
      kind: "notebook" as TabKind,
    }));
    const tabs = [...notebooks, app("a")];
    let mounted: readonly string[] = [];
    for (const t of tabs) mounted = nextMountedTabs(mounted, tabs, [t.id]);
    expect(mounted).toHaveLength(7);
  });

  it("drops closed tabs", () => {
    const mounted = nextMountedTabs([], [app("a"), app("b")], ["a"]);
    expect(nextMountedTabs(mounted, [app("b")], ["b"])).toEqual(["b"]);
  });

  it("leaves eager kinds (consoles) out of the list and always mounted", () => {
    const consoleTab = { id: "c1", kind: "console" as TabKind };
    const untyped = { id: "c2" };
    expect(nextMountedTabs([], [consoleTab, untyped], ["c1"])).toEqual([]);
    expect(isTabMounted(consoleTab, [])).toBe(true);
    expect(isTabMounted(untyped, [])).toBe(true);
    expect(isTabMounted(app("a"), [])).toBe(false);
    expect(isTabMounted(app("a"), ["a"])).toBe(true);
  });
});

/**
 * A stand-in for AppWorkspace's two expensive mount effects: it asks for a
 * view token and renders the published iframe. The Editor renders tab panels
 * exactly this way (see the guard below).
 */
const mintViewToken = vi.fn();
function FakeApp({ appId }: { appId: string }) {
  useEffect(() => {
    mintViewToken(appId);
  }, [appId]);
  return <iframe title={appId} data-testid={`frame-${appId}`} />;
}

function Panels({
  tabs,
  visible,
}: {
  tabs: { id: string; kind?: TabKind }[];
  visible: (string | null)[];
}) {
  const mounted = useMountedTabs(tabs, visible);
  return (
    <>
      {tabs.map(tab => (
        <div key={tab.id} data-tab={tab.id}>
          {isTabMounted(tab, mounted) ? <FakeApp appId={tab.id} /> : null}
        </div>
      ))}
    </>
  );
}

describe("useMountedTabs in a tab panel list", () => {
  afterEach(() => {
    cleanup();
    mintViewToken.mockReset();
  });

  const restored = ["a", "b", "c", "d", "e", "f", "g", "h"].map(app);

  it("a refresh with 8 restored app tabs mints 1 token and renders 1 iframe", () => {
    const { container } = render(<Panels tabs={restored} visible={["c"]} />);
    expect(mintViewToken.mock.calls).toEqual([["c"]]);
    expect(container.querySelectorAll("iframe")).toHaveLength(1);
  });

  it("mounts a tab on activation and keeps it, without remounting", () => {
    const { container, rerender } = render(
      <Panels tabs={restored} visible={["a"]} />,
    );
    act(() => rerender(<Panels tabs={restored} visible={["b"]} />));
    act(() => rerender(<Panels tabs={restored} visible={["a"]} />));
    expect(mintViewToken.mock.calls).toEqual([["a"], ["b"]]);
    expect(container.querySelectorAll("iframe")).toHaveLength(2);
  });

  it(`unmounts beyond ${APP_TAB_MOUNT_CAP} iframes and remounts on return`, () => {
    const { container, rerender } = render(
      <Panels tabs={restored} visible={["a"]} />,
    );
    for (const id of ["b", "c", "d", "e"]) {
      act(() => rerender(<Panels tabs={restored} visible={[id]} />));
    }
    expect(container.querySelectorAll("iframe")).toHaveLength(
      APP_TAB_MOUNT_CAP,
    );
    expect(container.querySelector('[data-testid="frame-a"]')).toBeNull();
    act(() => rerender(<Panels tabs={restored} visible={["a"]} />));
    expect(container.querySelector('[data-testid="frame-a"]')).not.toBeNull();
    expect(container.querySelector('[data-testid="frame-b"]')).toBeNull();
    expect(mintViewToken.mock.calls.filter(([id]) => id === "a")).toHaveLength(
      2,
    );
  });

  it("split view: both visible tabs mount", () => {
    const { container } = render(
      <Panels tabs={restored} visible={["b", "f"]} />,
    );
    expect(mintViewToken.mock.calls).toEqual([["b"], ["f"]]);
    expect(container.querySelectorAll("iframe")).toHaveLength(2);
  });
});

describe("Editor gates every tab panel through the mount policy", () => {
  const src = readFileSync(
    path.join(
      path.dirname(fileURLToPath(import.meta.url)),
      "../components/Editor.tsx",
    ),
    "utf8",
  );

  it("computes the mounted list from the active tab", () => {
    expect(src).toMatch(/useMountedTabs\(consoleTabs, \[activeConsoleId\]\)/);
  });

  it("renders nothing for an unmounted tab before any kind branch", () => {
    expect(src).toContain(
      "const panelMounted = isTabMounted(tab, mountedLazyTabs);",
    );
    const gate = src.indexOf("{!panelMounted ? null");
    expect(gate).toBeGreaterThan(-1);
    const appBranch = src.indexOf("<AppWorkspace", gate);
    const notebookBranch = src.indexOf("<NotebookRenderer", gate);
    expect(appBranch).toBeGreaterThan(gate);
    expect(notebookBranch).toBeGreaterThan(gate);
  });
});

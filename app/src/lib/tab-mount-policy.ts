/**
 * Which open tabs have their content mounted.
 *
 * Tabs persist in localStorage, so a refresh restores every one of them. The
 * Editor used to mount all of them at once (display: none for the hidden
 * ones). For an app tab a mount is a view-token request, a sandboxed iframe
 * (HTML + 0.5–1.7 MB of JS, uncached because the frame's origin is opaque),
 * a DuckDB-WASM boot (6 MB WASM) and every parquet binding. With ten app tabs
 * a refresh loaded ten apps, all competing with the one on screen.
 *
 * A lazy kind mounts the first time it is visible and then stays mounted, so
 * switching back is instant and keeps its state. A kind with a cap keeps at
 * most that many mounted tabs: the least recently visible one beyond the cap
 * is unmounted. A visible tab is never evicted. Every other kind keeps the old
 * eager behaviour: consoles in particular receive agent diffs and realtime
 * content through their mounted Monaco ref, even in the background.
 *
 * Browser-local by nature: one page's own rendering, no persisted state. The
 * persisted tab schema is untouched.
 */
import { useState } from "react";
import type { TabKind } from "../store/lib/types";

interface TabMountRule {
  /** Most tabs of this kind kept mounted; omitted = no cap. */
  cap?: number;
}

/**
 * App tabs: at most 4 mounted. Each one holds an iframe with a DuckDB-WASM
 * worker plus its decoded tables (tens to hundreds of MB for IDX Portal or
 * Financial Model). Re-mounting an evicted one re-downloads its WASM, JS and
 * parquet, because the opaque-origin frame bypasses the HTTP cache. 4 covers
 * the front app plus the 3 it is being compared with, at a worst case of
 * about 1 GB of renderer memory.
 *
 * Notebook tabs: lazy, no cap. A mounted notebook fetches its document and
 * heartbeats presence every few seconds, which also told collaborators that
 * someone was looking at a notebook that sat in a background tab.
 */
export const APP_TAB_MOUNT_CAP = 4;

export const TAB_MOUNT_RULES: Partial<Record<TabKind, TabMountRule>> = {
  app: { cap: APP_TAB_MOUNT_CAP },
  notebook: {},
};

interface TabRef {
  id: string;
  kind?: TabKind;
}

function ruleFor(tab: TabRef): TabMountRule | undefined {
  return TAB_MOUNT_RULES[tab.kind ?? "console"];
}

/** Whether this tab's content is rendered, given the lazy-mount list. */
export function isTabMounted(tab: TabRef, mounted: readonly string[]): boolean {
  return !ruleFor(tab) || mounted.includes(tab.id);
}

/**
 * The next list of mounted lazy tabs, least recently visible first.
 *
 * Closed tabs drop out, visible tabs move to the end (in the order given),
 * and each capped kind loses its oldest invisible tabs until it fits. Returns
 * `prev` itself when nothing changed, so a caller can store it in state.
 */
export function nextMountedTabs(
  prev: readonly string[],
  tabs: readonly TabRef[],
  visibleIds: readonly (string | null | undefined)[],
): readonly string[] {
  const kindOf = new Map<string, TabKind>();
  for (const t of tabs) if (ruleFor(t)) kindOf.set(t.id, t.kind ?? "console");
  const visible = visibleIds.filter(
    (id): id is string => !!id && kindOf.has(id),
  );
  let next = prev.filter(id => kindOf.has(id) && !visible.includes(id));
  next.push(...visible);

  const countByKind = new Map<TabKind, number>();
  for (const id of next) {
    const kind = kindOf.get(id) ?? "console";
    countByKind.set(kind, (countByKind.get(kind) ?? 0) + 1);
  }
  for (const [kind, count] of countByKind) {
    const cap = TAB_MOUNT_RULES[kind]?.cap;
    if (cap === undefined || count <= cap) continue;
    let excess = count - cap;
    next = next.filter(id => {
      if (excess <= 0 || visible.includes(id) || kindOf.get(id) !== kind) {
        return true;
      }
      excess--;
      return false;
    });
  }

  const unchanged =
    next.length === prev.length && next.every((id, i) => id === prev[i]);
  return unchanged ? prev : next;
}

/**
 * The lazy-mount list for the Editor's tab panels. `visibleIds` are the tabs
 * on screen (the active tab; both panes if a split view ever shows two).
 * Uses the "adjust state while rendering" pattern: the list converges in the
 * same render because `nextMountedTabs` returns `prev` when nothing changed.
 */
export function useMountedTabs(
  tabs: readonly TabRef[],
  visibleIds: readonly (string | null | undefined)[],
): readonly string[] {
  const [mounted, setMounted] = useState<readonly string[]>([]);
  const next = nextMountedTabs(mounted, tabs, visibleIds);
  if (next !== mounted) setMounted(next);
  return next;
}

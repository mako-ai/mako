/**
 * Recently opened entities, per workspace — the "Recent" list on the phone's
 * Browse tab. Nothing server-side knows "what this person looked at last",
 * so the shell records it locally every time a tab becomes active: a phone
 * that opened the app after a desktop session shows nothing, but anything
 * touched on this device is one tap away.
 *
 * Only durable, reopenable kinds are recorded — the entry must carry enough
 * to reopen the entity on a fresh page (id + title, plus the app slug), and
 * transient tabs (settings, diffs, plans) would only be noise.
 */
import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";

export type RecentKind = "console" | "dashboard" | "notebook" | "app";

export interface RecentEntry {
  kind: RecentKind;
  /** The entity id (console id, dashboard id, ...). */
  id: string;
  title: string;
  /** Apps: the slug rides along so the URL upgrades on reopen. */
  slug?: string;
  /** Last activation, epoch ms. */
  at: number;
}

/** Newest first; older entries fall off the end. */
export const MAX_RECENTS_PER_WORKSPACE = 12;

interface RecentsState {
  byWorkspace: Record<string, RecentEntry[]>;
}

interface RecentsActions {
  /** Move-or-insert to the front of the workspace's list, refreshing title. */
  record: (workspaceId: string, entry: Omit<RecentEntry, "at">) => void;
  /** Drop an entry (the entity no longer exists). */
  remove: (workspaceId: string, kind: RecentKind, id: string) => void;
  reset: () => void;
}

type RecentsStore = RecentsState & RecentsActions;

export const useRecentsStore = create<RecentsStore>()(
  persist(
    immer(set => ({
      byWorkspace: {},

      record: (workspaceId, entry) =>
        set(state => {
          const list = state.byWorkspace[workspaceId] ?? [];
          const rest = list.filter(
            e => !(e.kind === entry.kind && e.id === entry.id),
          );
          state.byWorkspace[workspaceId] = [
            { ...entry, at: Date.now() },
            ...rest,
          ].slice(0, MAX_RECENTS_PER_WORKSPACE);
        }),

      remove: (workspaceId, kind, id) =>
        set(state => {
          const list = state.byWorkspace[workspaceId];
          if (!list) return;
          state.byWorkspace[workspaceId] = list.filter(
            e => !(e.kind === kind && e.id === id),
          );
        }),

      reset: () => set({ byWorkspace: {} }),
    })),
    { name: "recents-store" },
  ),
);

/** Empty-array constant so selectors return a stable reference. */
const NO_RECENTS: RecentEntry[] = [];

export const selectRecents =
  (workspaceId: string | undefined) =>
  (state: RecentsStore): RecentEntry[] =>
    workspaceId ? (state.byWorkspace[workspaceId] ?? NO_RECENTS) : NO_RECENTS;

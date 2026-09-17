/**
 * Favourites — this user's bookmark tree over the workspace's entities.
 *
 * One flat list of rows per workspace, straight from the API: folders and
 * items in a self-referential tree (`parentId`), ordered by `position`. An
 * item points at an entity by (kind, refId) and carries nothing else — the
 * explorer resolves it against its own listing when it renders, and drops it
 * silently if the entity is gone or invisible to this user.
 *
 * A star is a VIEW, never a location: nothing here can change an entity's
 * folder, sharing, identity or deployment. That is why every edit is
 * optimistic — a star, a drag into a folder, a reorder — and a failure
 * restores the previous rows and surfaces the message.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, toErrorMessage, unwrapBody } from "../api";

export type FavouriteKind = "app" | "console" | "notebook" | "dashboard";

export interface Favourite {
  id: string;
  parentId: string | null;
  type: "folder" | "item";
  title?: string;
  kind?: FavouriteKind;
  refId?: string;
  position: number;
}

const BASE = "/api/workspaces/{workspaceId}/favourites" as const;

interface FavouritesState {
  byWorkspace: Record<string, Favourite[]>;
  loading: Record<string, boolean>;
  error: string | null;
}

interface FavouritesActions {
  fetch: (workspaceId: string) => Promise<void>;
  /** Star or unstar one entity. Idempotent. */
  toggle: (
    workspaceId: string,
    kind: FavouriteKind,
    refId: string,
    starred: boolean,
    parentId?: string | null,
  ) => Promise<boolean>;
  createFolder: (
    workspaceId: string,
    title: string,
    parentId?: string | null,
  ) => Promise<Favourite | null>;
  rename: (workspaceId: string, id: string, title: string) => Promise<boolean>;
  /** Move a row (item or folder) into a folder and/or to a position. */
  move: (
    workspaceId: string,
    id: string,
    parentId: string | null,
    position?: number,
  ) => Promise<boolean>;
  remove: (workspaceId: string, id: string) => Promise<boolean>;
  clearError: () => void;
  reset: () => void;
}

const EMPTY: Favourite[] = [];

export const selectFavourites =
  (workspaceId: string | undefined) =>
  (s: FavouritesState): Favourite[] =>
    workspaceId ? (s.byWorkspace[workspaceId] ?? EMPTY) : EMPTY;

/** The starred refIds of one kind. */
export function starredRefs(
  favourites: Favourite[],
  kind: FavouriteKind,
): Set<string> {
  const out = new Set<string>();
  for (const f of favourites) {
    if (f.type === "item" && f.kind === kind && f.refId) out.add(f.refId);
  }
  return out;
}

/** The item row pointing at an entity, if starred. */
export function favouriteFor(
  favourites: Favourite[],
  kind: FavouriteKind,
  refId: string,
): Favourite | undefined {
  return favourites.find(
    f => f.type === "item" && f.kind === kind && f.refId === refId,
  );
}

export const useFavouritesStore = create<FavouritesState & FavouritesActions>()(
  immer((set, get) => ({
    byWorkspace: {},
    loading: {},
    error: null,

    fetch: async workspaceId => {
      set(s => {
        s.loading[workspaceId] = true;
      });
      try {
        const body = unwrapBody(
          await api.GET(BASE, { params: { path: { workspaceId } } }),
        ) as { favourites?: Favourite[] };
        set(s => {
          s.byWorkspace[workspaceId] = body.favourites ?? [];
          s.loading[workspaceId] = false;
        });
      } catch (e) {
        set(s => {
          s.loading[workspaceId] = false;
          s.error = toErrorMessage(e, "Failed to load favourites");
        });
      }
    },

    toggle: async (workspaceId, kind, refId, starred, parentId = null) => {
      // Optimistic: the row appears or disappears immediately.
      set(s => {
        const rows = s.byWorkspace[workspaceId] ?? [];
        const without = rows.filter(
          f => !(f.type === "item" && f.kind === kind && f.refId === refId),
        );
        if (starred) {
          const siblings = without.filter(f => f.parentId === parentId);
          without.push({
            id: `pending:${kind}:${refId}`,
            parentId,
            type: "item",
            kind,
            refId,
            position: siblings.length,
          });
        }
        s.byWorkspace[workspaceId] = without;
      });
      try {
        if (starred) {
          const body = unwrapBody(
            await api.PUT(`${BASE}/items/{kind}/{refId}`, {
              params: { path: { workspaceId, kind, refId } },
              body: { parentId },
            }),
          ) as { favourite?: Favourite };
          if (body.favourite) {
            const row = body.favourite;
            set(s => {
              const rows = s.byWorkspace[workspaceId] ?? [];
              const i = rows.findIndex(
                f => f.id === `pending:${kind}:${refId}`,
              );
              if (i >= 0) rows[i] = row;
              else rows.push(row);
            });
          }
        } else {
          unwrapBody(
            await api.DELETE(`${BASE}/items/{kind}/{refId}`, {
              params: { path: { workspaceId, kind, refId } },
            }),
          );
        }
        return true;
      } catch (e) {
        // Do NOT restore a snapshot: another toggle may have completed in
        // between, and putting the old rows back would undo it (and leave
        // this placeholder behind to 404 on its next move). Drop the
        // placeholder, then let the server say what the rows are.
        set(s => {
          s.byWorkspace[workspaceId] = (
            s.byWorkspace[workspaceId] ?? []
          ).filter(f => f.id !== `pending:${kind}:${refId}`);
          s.error = toErrorMessage(e, "Failed to update favourites");
        });
        await get().fetch(workspaceId);
        return false;
      }
    },

    createFolder: async (workspaceId, title, parentId = null) => {
      try {
        const body = unwrapBody(
          await api.POST(`${BASE}/folders`, {
            params: { path: { workspaceId } },
            body: { title, parentId },
          }),
        ) as { favourite?: Favourite };
        if (!body.favourite) return null;
        const row = body.favourite;
        set(s => {
          (s.byWorkspace[workspaceId] ??= []).push(row);
        });
        return row;
      } catch (e) {
        set(s => {
          s.error = toErrorMessage(e, "Failed to create folder");
        });
        return null;
      }
    },

    rename: async (workspaceId, id, title) => {
      const previous = get().byWorkspace[workspaceId] ?? [];
      set(s => {
        const row = (s.byWorkspace[workspaceId] ?? []).find(f => f.id === id);
        if (row) row.title = title;
      });
      try {
        unwrapBody(
          await api.PATCH(`${BASE}/{id}`, {
            params: { path: { workspaceId, id } },
            body: { title },
          }),
        );
        return true;
      } catch (e) {
        set(s => {
          s.byWorkspace[workspaceId] = previous;
          s.error = toErrorMessage(e, "Failed to rename folder");
        });
        return false;
      }
    },

    move: async (workspaceId, id, parentId, position) => {
      const previous = get().byWorkspace[workspaceId] ?? [];
      // Optimistic re-parent; positions are re-read from the server's answer
      // on the next fetch, and the tree renders by parent + position order.
      set(s => {
        const rows = s.byWorkspace[workspaceId] ?? [];
        const row = rows.find(f => f.id === id);
        if (!row) return;
        const siblings = rows
          .filter(f => f.parentId === parentId && f.id !== id)
          .sort((a, b) => a.position - b.position);
        const at = Math.max(
          0,
          Math.min(position ?? siblings.length, siblings.length),
        );
        siblings.splice(at, 0, row);
        row.parentId = parentId;
        siblings.forEach((f, i) => {
          f.position = i;
        });
      });
      try {
        unwrapBody(
          await api.PATCH(`${BASE}/{id}`, {
            params: { path: { workspaceId, id } },
            body: { parentId, ...(position !== undefined ? { position } : {}) },
          }),
        );
        void get().fetch(workspaceId);
        return true;
      } catch (e) {
        set(s => {
          s.byWorkspace[workspaceId] = previous;
          s.error = toErrorMessage(e, "Failed to move favourite");
        });
        return false;
      }
    },

    remove: async (workspaceId, id) => {
      const previous = get().byWorkspace[workspaceId] ?? [];
      set(s => {
        const rows = s.byWorkspace[workspaceId] ?? [];
        // A folder takes its subtree with it, exactly as the server does.
        const gone = new Set([id]);
        let grew = true;
        while (grew) {
          grew = false;
          for (const f of rows) {
            if (f.parentId && gone.has(f.parentId) && !gone.has(f.id)) {
              gone.add(f.id);
              grew = true;
            }
          }
        }
        s.byWorkspace[workspaceId] = rows.filter(f => !gone.has(f.id));
      });
      try {
        unwrapBody(
          await api.DELETE(`${BASE}/{id}`, {
            params: { path: { workspaceId, id } },
          }),
        );
        return true;
      } catch (e) {
        set(s => {
          s.byWorkspace[workspaceId] = previous;
          s.error = toErrorMessage(e, "Failed to remove favourite");
        });
        return false;
      }
    },

    clearError: () => set(s => void (s.error = null)),
    reset: () =>
      set(s => {
        s.byWorkspace = {};
        s.loading = {};
        s.error = null;
      }),
  })),
);

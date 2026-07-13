import { create } from "zustand";

import { apiClient } from "../lib/api-client";
import type { KernelOutput } from "../notebook-runtime/kernel";
import { useUIStore } from "./uiStore";
import { realtimeClientId } from "../lib/realtime-client-id";

/**
 * Notebook store — talks to the working-tree CRUD API
 * (`/api/workspaces/:id/notebooks`) and owns the editable state of notebooks
 * currently open in a tab (`openNotebooks`). Centralizing edit state here (vs
 * component-local) lets both the editor and the AI agent (and, later, live
 * collaboration) mutate the same notebook through one set of actions, with
 * shared debounced autosave.
 */
export type NotebookBlockType = "code" | "sql" | "markdown";

/** A rendered output persisted with a cell (survives reload). Mirrors the API
 * schema: kernel outputs for code cells + a `sql` variant for SQL results. */
export type NotebookCellOutput =
  | KernelOutput
  | {
      type: "sql";
      rows: unknown[];
      fields?: Array<{ name?: string; originalName?: string } | string>;
      rowCount: number;
      executionTime?: number;
      truncated?: boolean;
    };

export interface NotebookBlock {
  id: string;
  type: NotebookBlockType;
  source: string;
  connectionId?: string;
  outputs?: NotebookCellOutput[];
  executionCount?: number;
  executedAt?: string;
}

export interface NotebookDoc {
  id: string;
  name: string;
  blocks: NotebookBlock[];
  /** Server version, bumped on each save (drives realtime poke-then-pull). */
  version: number;
  createdAt: string;
  updatedAt: string;
}

export interface NotebookSummary {
  id: string;
  name: string;
  updatedAt: string;
}

export type NotebookSaveState = "idle" | "saving" | "saved" | "error";

function currentWorkspaceId(): string | null {
  return useUIStore.getState().currentWorkspaceId ?? null;
}

function makeBlock(type: NotebookBlockType): NotebookBlock {
  return { id: crypto.randomUUID(), type, source: "" };
}

// Per-notebook autosave debounce timers (module scope; not reactive state).
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const SAVE_DEBOUNCE_MS = 700;

interface NotebookStore {
  notebooks: NotebookSummary[];
  isLoading: boolean;
  error: string | null;
  /** Editable doc state for notebooks currently open in a tab. */
  openNotebooks: Record<string, NotebookDoc>;
  saveState: Record<string, NotebookSaveState>;

  loadNotebooks: () => Promise<void>;
  createNotebook: (name?: string) => Promise<NotebookDoc | null>;
  getNotebook: (id: string) => Promise<NotebookDoc | null>;
  deleteNotebook: (id: string) => Promise<void>;
  updateNotebook: (
    id: string,
    patch: { name?: string; blocks?: NotebookBlock[] },
  ) => Promise<NotebookDoc | null>;

  // -- open-notebook editing (editor + agent + collab share these) ----------
  /** Load a notebook into editable open state (no-op if already open). */
  openNotebook: (id: string) => Promise<void>;
  renameOpenNotebook: (id: string, name: string) => void;
  addCell: (
    id: string,
    type: NotebookBlockType,
    atIndex?: number,
  ) => NotebookBlock | null;
  updateCell: (
    id: string,
    cellId: string,
    patch: Partial<NotebookBlock>,
  ) => void;
  deleteCell: (id: string, cellId: string) => void;
  moveCell: (id: string, index: number, direction: -1 | 1) => void;
  /** Pull a fresh copy of an open notebook (realtime poke-then-pull). */
  reloadOpenNotebook: (id: string) => Promise<void>;
  /** Create a notebook from imported blocks (e.g. an uploaded .ipynb). */
  importNotebook: (
    name: string,
    blocks: NotebookBlock[],
  ) => Promise<NotebookDoc | null>;
}

export const useNotebookStore = create<NotebookStore>((set, get) => {
  const scheduleSave = (id: string, nameChanged: boolean) => {
    const existing = saveTimers.get(id);
    if (existing) clearTimeout(existing);
    set(s => ({ saveState: { ...s.saveState, [id]: "saving" } }));
    saveTimers.set(
      id,
      setTimeout(() => {
        const doc = get().openNotebooks[id];
        if (!doc) return;
        void get()
          .updateNotebook(id, {
            name: nameChanged ? doc.name : undefined,
            blocks: doc.blocks,
          })
          .then(res =>
            set(s => ({
              saveState: { ...s.saveState, [id]: res ? "saved" : "error" },
            })),
          );
      }, SAVE_DEBOUNCE_MS),
    );
  };

  const applyEdit = (
    id: string,
    updater: (d: NotebookDoc) => NotebookDoc,
    nameChanged = false,
  ) => {
    const current = get().openNotebooks[id];
    if (!current) return;
    set(s => ({
      openNotebooks: { ...s.openNotebooks, [id]: updater(current) },
    }));
    scheduleSave(id, nameChanged);
  };

  return {
    notebooks: [],
    isLoading: false,
    error: null,
    openNotebooks: {},
    saveState: {},

    loadNotebooks: async () => {
      const ws = currentWorkspaceId();
      if (!ws) return;
      set({ isLoading: true, error: null });
      try {
        const res = await apiClient.get<{ data: NotebookSummary[] }>(
          `/workspaces/${ws}/notebooks`,
        );
        set({ notebooks: res.data ?? [], isLoading: false });
      } catch (e) {
        set({
          isLoading: false,
          error: e instanceof Error ? e.message : "Failed to load notebooks",
        });
      }
    },

    createNotebook: async name => {
      const ws = currentWorkspaceId();
      if (!ws) return null;
      try {
        const res = await apiClient.post<{ data: NotebookDoc }>(
          `/workspaces/${ws}/notebooks`,
          { name, clientId: realtimeClientId },
        );
        await get().loadNotebooks();
        return res.data ?? null;
      } catch (e) {
        set({
          error: e instanceof Error ? e.message : "Failed to create notebook",
        });
        return null;
      }
    },

    getNotebook: async id => {
      const ws = currentWorkspaceId();
      if (!ws) return null;
      try {
        const res = await apiClient.get<{ data: NotebookDoc }>(
          `/workspaces/${ws}/notebooks/${id}`,
        );
        return res.data ?? null;
      } catch {
        return null;
      }
    },

    deleteNotebook: async id => {
      const ws = currentWorkspaceId();
      if (!ws) return;
      try {
        await apiClient.delete(`/workspaces/${ws}/notebooks/${id}`);
        await get().loadNotebooks();
      } catch (e) {
        set({
          error: e instanceof Error ? e.message : "Failed to delete notebook",
        });
      }
    },

    updateNotebook: async (id, patch) => {
      const ws = currentWorkspaceId();
      if (!ws) return null;
      try {
        const res = await apiClient.patch<{ data: NotebookDoc }>(
          `/workspaces/${ws}/notebooks/${id}`,
          { ...patch, clientId: realtimeClientId },
        );
        const doc = res.data ?? null;
        // Reflect a rename in the explorer list without a reload storm.
        if (doc && patch.name !== undefined) {
          set(state => ({
            notebooks: state.notebooks.map(n =>
              n.id === id
                ? { ...n, name: doc.name, updatedAt: doc.updatedAt }
                : n,
            ),
          }));
        }
        return doc;
      } catch (e) {
        set({
          error: e instanceof Error ? e.message : "Failed to save notebook",
        });
        return null;
      }
    },

    openNotebook: async id => {
      if (get().openNotebooks[id]) return;
      const doc = await get().getNotebook(id);
      if (doc) {
        set(s => ({
          openNotebooks: { ...s.openNotebooks, [id]: doc },
          saveState: { ...s.saveState, [id]: "idle" },
        }));
      }
    },

    reloadOpenNotebook: async id => {
      // Only for open notebooks; never clobber an in-flight local edit (the
      // next poke / focus reconciles).
      if (!get().openNotebooks[id]) return;
      if (get().saveState[id] === "saving") return;
      const doc = await get().getNotebook(id);
      if (doc) {
        set(s => ({
          openNotebooks: { ...s.openNotebooks, [id]: doc },
          saveState: { ...s.saveState, [id]: "idle" },
        }));
      }
    },

    importNotebook: async (name, blocks) => {
      const created = await get().createNotebook(name);
      if (!created) return null;
      const updated = await get().updateNotebook(created.id, { blocks });
      return updated ?? created;
    },

    renameOpenNotebook: (id, name) =>
      applyEdit(id, d => ({ ...d, name }), true),

    addCell: (id, type, atIndex) => {
      if (!get().openNotebooks[id]) return null;
      const cell = makeBlock(type);
      applyEdit(id, d => {
        const blocks = [...d.blocks];
        blocks.splice(atIndex ?? blocks.length, 0, cell);
        return { ...d, blocks };
      });
      return cell;
    },

    updateCell: (id, cellId, patch) =>
      applyEdit(id, d => ({
        ...d,
        blocks: d.blocks.map(b => (b.id === cellId ? { ...b, ...patch } : b)),
      })),

    deleteCell: (id, cellId) =>
      applyEdit(id, d => ({
        ...d,
        blocks: d.blocks.filter(b => b.id !== cellId),
      })),

    moveCell: (id, index, direction) =>
      applyEdit(id, d => {
        const target = index + direction;
        if (target < 0 || target >= d.blocks.length) return d;
        const blocks = [...d.blocks];
        [blocks[index], blocks[target]] = [blocks[target], blocks[index]];
        return { ...d, blocks };
      }),
  };
});

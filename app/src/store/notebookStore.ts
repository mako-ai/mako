import { create } from "zustand";

import { apiClient } from "../lib/api-client";
import { ApiError } from "../api/result";
import type { KernelOutput } from "../notebook-runtime/kernel";
import { useUIStore } from "./uiStore";
import { realtimeClientId } from "../lib/realtime-client-id";
import { useNotebookTreeStore } from "./notebookTreeStore";

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

/** A prior generation of a notebook, for the history panel. Mirrors the API's
 * `NotebookVersion`; `versionId` is opaque (passed back to restore). */
export interface NotebookVersion {
  versionId: string;
  createdAt: string;
  size: number;
  isCurrent: boolean;
}

function currentWorkspaceId(): string | null {
  return useUIStore.getState().currentWorkspaceId ?? null;
}

function makeBlock(type: NotebookBlockType): NotebookBlock {
  return { id: crypto.randomUUID(), type, source: "" };
}

// Per-notebook autosave debounce timers (module scope; not reactive state).
const saveTimers = new Map<string, ReturnType<typeof setTimeout>>();
const saveNamePending = new Map<string, boolean>();
const saveInFlight = new Set<string>();
const queuedSaves = new Map<
  string,
  { nameChanged: boolean; revision: number }
>();
const saveRevisions = new Map<string, number>();
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
    expectedVersion?: number,
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
  /** Clear persisted outputs from every cell (Jupyter "Clear all outputs"). */
  clearAllOutputs: (id: string) => void;
  /** Clear persisted outputs from one cell. */
  clearCellOutputs: (id: string, cellId: string) => void;
  /** Pull a fresh copy of an open notebook (realtime poke-then-pull). */
  reloadOpenNotebook: (id: string) => Promise<void>;
  /** List prior generations of a notebook (newest first). */
  listVersions: (id: string) => Promise<NotebookVersion[]>;
  /** Restore a prior generation as the new current; updates the open editor. */
  restoreVersion: (id: string, versionId: string) => Promise<boolean>;
  /** Create a notebook from imported blocks (e.g. an uploaded .ipynb). */
  importNotebook: (
    name: string,
    blocks: NotebookBlock[],
  ) => Promise<NotebookDoc | null>;
}

export const useNotebookStore = create<NotebookStore>((set, get) => {
  const flushSave = async (
    id: string,
    nameChanged: boolean,
    revision: number,
  ): Promise<void> => {
    if (saveInFlight.has(id)) {
      const queued = queuedSaves.get(id);
      queuedSaves.set(id, {
        nameChanged: (queued?.nameChanged ?? false) || nameChanged,
        revision: Math.max(queued?.revision ?? 0, revision),
      });
      return;
    }

    saveInFlight.add(id);
    try {
      const doc = get().openNotebooks[id];
      if (!doc) return;
      const res = await get().updateNotebook(
        id,
        {
          name: nameChanged ? doc.name : undefined,
          blocks: doc.blocks,
        },
        doc.version,
      );
      if (saveRevisions.get(id) === revision) {
        set(s => ({
          saveState: { ...s.saveState, [id]: res ? "saved" : "error" },
        }));
      }
    } finally {
      saveInFlight.delete(id);
      const queued = queuedSaves.get(id);
      if (queued) {
        queuedSaves.delete(id);
        await flushSave(id, queued.nameChanged, queued.revision);
      }
    }
  };

  const scheduleSave = (id: string, nameChanged: boolean) => {
    const existing = saveTimers.get(id);
    if (existing) clearTimeout(existing);
    saveNamePending.set(id, (saveNamePending.get(id) ?? false) || nameChanged);
    const revision = (saveRevisions.get(id) ?? 0) + 1;
    saveRevisions.set(id, revision);
    set(s => ({ saveState: { ...s.saveState, [id]: "saving" } }));
    saveTimers.set(
      id,
      setTimeout(() => {
        saveTimers.delete(id);
        const includeName = saveNamePending.get(id) ?? false;
        saveNamePending.delete(id);
        void flushSave(id, includeName, revision);
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
      await useNotebookTreeStore.getState().refresh(ws);
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

    updateNotebook: async (id, patch, expectedVersion) => {
      const ws = currentWorkspaceId();
      if (!ws) return null;
      try {
        const res = await apiClient.patch<{ data: NotebookDoc }>(
          `/workspaces/${ws}/notebooks/${id}`,
          { ...patch, clientId: realtimeClientId, expectedVersion },
        );
        const doc = res.data ?? null;
        if (doc) {
          // Keep any local edits made while this request was in flight, but
          // advance their concurrency base to the version the server accepted.
          set(state => {
            const current = state.openNotebooks[id];
            if (!current) return state;
            return {
              openNotebooks: {
                ...state.openNotebooks,
                [id]: {
                  ...current,
                  version: Math.max(current.version, doc.version),
                  updatedAt: doc.updatedAt,
                },
              },
            };
          });
        }
        // Reflect a rename in the explorer tree without a full reload storm.
        if (doc && patch.name !== undefined && ws) {
          void useNotebookTreeStore
            .getState()
            .renameItem(ws, id, doc.name, false);
        }
        return doc;
      } catch (e) {
        const current = get().openNotebooks[id];
        if (
          e instanceof ApiError &&
          e.status === 409 &&
          expectedVersion !== undefined &&
          current &&
          current.version > expectedVersion
        ) {
          // A restore/reload or an earlier serialized save already advanced
          // this editor past the rejected request; do not surface a stale
          // conflict over the newer local state.
          return current;
        }
        set({
          error:
            e instanceof ApiError && e.status === 409
              ? "Notebook changed elsewhere. Reload it before saving again."
              : e instanceof Error
                ? e.message
                : "Failed to save notebook",
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
      const updated = await get().updateNotebook(
        created.id,
        { blocks },
        created.version,
      );
      return updated ?? created;
    },

    listVersions: async id => {
      const ws = currentWorkspaceId();
      if (!ws) return [];
      try {
        const res = await apiClient.get<{ data: NotebookVersion[] }>(
          `/workspaces/${ws}/notebooks/${id}/versions`,
        );
        return res.data ?? [];
      } catch {
        return [];
      }
    },

    restoreVersion: async (id, versionId) => {
      const ws = currentWorkspaceId();
      if (!ws) return false;
      // Restore discards the current working state, so cancel any pending
      // autosave that would otherwise re-persist the pre-restore blocks.
      const timer = saveTimers.get(id);
      if (timer) {
        clearTimeout(timer);
        saveTimers.delete(id);
      }
      saveNamePending.delete(id);
      queuedSaves.delete(id);
      // Invalidate any save already in flight so its completion cannot replace
      // the restore's idle state with a stale success/error result.
      saveRevisions.set(id, (saveRevisions.get(id) ?? 0) + 1);
      try {
        const res = await apiClient.post<{ data: NotebookDoc }>(
          `/workspaces/${ws}/notebooks/${id}/versions/${versionId}/restore`,
          { clientId: realtimeClientId },
        );
        const doc = res.data;
        if (!doc) return false;
        // Reflect the restored doc immediately if the notebook is open.
        set(s =>
          s.openNotebooks[id]
            ? {
                openNotebooks: { ...s.openNotebooks, [id]: doc },
                saveState: { ...s.saveState, [id]: "idle" },
                error: null,
              }
            : {},
        );
        void get().loadNotebooks(); // refresh explorer updatedAt
        return true;
      } catch {
        return false;
      }
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

    clearAllOutputs: id =>
      applyEdit(id, d => ({
        ...d,
        blocks: d.blocks.map(b => ({
          ...b,
          outputs: undefined,
          executionCount: undefined,
          executedAt: undefined,
        })),
      })),

    clearCellOutputs: (id, cellId) =>
      applyEdit(id, d => ({
        ...d,
        blocks: d.blocks.map(b =>
          b.id === cellId
            ? {
                ...b,
                outputs: undefined,
                executionCount: undefined,
                executedAt: undefined,
              }
            : b,
        ),
      })),
  };
});

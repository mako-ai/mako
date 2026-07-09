import { create } from "zustand";

import { apiClient } from "../lib/api-client";
import { useUIStore } from "./uiStore";

/**
 * Notebook store — talks to the working-tree CRUD API
 * (`/api/workspaces/:id/notebooks`). Notebooks are the system of record in Git;
 * this store reads/writes the live working tree through the control plane.
 * Block editing + kernels land in later slices.
 */
export type NotebookBlockType = "code" | "sql" | "markdown";

export interface NotebookBlock {
  id: string;
  type: NotebookBlockType;
  source: string;
  connectionId?: string;
}

export interface NotebookDoc {
  id: string;
  name: string;
  blocks: NotebookBlock[];
  createdAt: string;
  updatedAt: string;
}

export interface NotebookSummary {
  id: string;
  name: string;
  updatedAt: string;
}

function currentWorkspaceId(): string | null {
  return useUIStore.getState().currentWorkspaceId ?? null;
}

interface NotebookStore {
  notebooks: NotebookSummary[];
  isLoading: boolean;
  error: string | null;
  loadNotebooks: () => Promise<void>;
  createNotebook: (name?: string) => Promise<NotebookDoc | null>;
  getNotebook: (id: string) => Promise<NotebookDoc | null>;
  deleteNotebook: (id: string) => Promise<void>;
  updateNotebook: (
    id: string,
    patch: { name?: string; blocks?: NotebookBlock[] },
  ) => Promise<NotebookDoc | null>;
}

export const useNotebookStore = create<NotebookStore>((set, get) => ({
  notebooks: [],
  isLoading: false,
  error: null,

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
        { name },
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
        patch,
      );
      const doc = res.data ?? null;
      // Reflect a rename in the explorer list without reloading it on every
      // block autosave.
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
}));

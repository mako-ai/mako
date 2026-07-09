import { create } from "zustand";

/**
 * Notebook store (scaffold).
 *
 * Holds the workspace's notebook list for the explorer. Notebook CRUD lands
 * with the Git-backed storage slice — notebooks live in Git (one repo per
 * workspace, under `jupyter/`), not Mongo — so this store is intentionally an
 * empty, ready-to-fill shell today. Once `GET /api/workspaces/:id/notebooks`
 * exists, `loadNotebooks` fetches through the typed api client, mirroring
 * `appStore`/`dashboardStore`.
 */
export interface NotebookSummary {
  id: string;
  name: string;
  updatedAt?: string;
}

interface NotebookStore {
  notebooks: NotebookSummary[];
  isLoading: boolean;
  error: string | null;
  loadNotebooks: () => Promise<void>;
}

export const useNotebookStore = create<NotebookStore>(set => ({
  notebooks: [],
  isLoading: false,
  error: null,
  loadNotebooks: async () => {
    // TODO(notebooks-git-storage): fetch from the Git-backed notebook list
    // endpoint once it exists (#3). Until then the explorer shows an empty
    // state rather than calling a route that isn't wired.
    set({ notebooks: [], isLoading: false, error: null });
  },
}));

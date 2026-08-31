import { api, unwrapBody } from "../api";
import {
  createResourceTreeStore,
  type ResourceTreeEntry,
  type TreeAccessLevel,
} from "./lib/createResourceTreeStore";

export type NotebookAccessLevel = TreeAccessLevel;
export type NotebookEntry = ResourceTreeEntry;

const base = "/api/workspaces/{workspaceId}/notebooks" as const;

/** The notebooks tree: entry type + endpoints; mechanics in the factory. */
export const useNotebookTreeStore = createResourceTreeStore<NotebookEntry>({
  resourceName: "notebook",
  endpoints: {
    fetch: async workspaceId => {
      const data = unwrapBody(
        await api.GET(base, { params: { path: { workspaceId } } }),
      ) as {
        myNotebooks?: NotebookEntry[];
        workspaceNotebooks?: NotebookEntry[];
      };
      return {
        my: data.myNotebooks ?? [],
        workspace: data.workspaceNotebooks ?? [],
      };
    },
    moveItem: async (workspaceId, id, folderId, access) =>
      unwrapBody(
        await api.PATCH(`${base}/{id}/move`, {
          params: { path: { workspaceId, id } },
          body: { folderId, access },
        }),
      ),
    moveFolder: async (workspaceId, id, parentId, access) =>
      unwrapBody(
        await api.PATCH(`${base}/folders/{id}/move`, {
          params: { path: { workspaceId, id } },
          body: { parentId, access },
        }),
      ),
    createFolder: async (workspaceId, name, parentId, access) =>
      (
        unwrapBody(
          await api.POST(`${base}/folders`, {
            params: { path: { workspaceId } },
            body: { name, parentId, access },
          }),
        ) as { data?: { id: string } }
      ).data,
    renameItem: async (workspaceId, id, name) =>
      unwrapBody(
        await api.PATCH(`${base}/{id}`, {
          params: { path: { workspaceId, id } },
          body: { name },
        }),
      ),
    renameFolder: async (workspaceId, id, name) =>
      unwrapBody(
        await api.PATCH(`${base}/folders/{id}/rename`, {
          params: { path: { workspaceId, id } },
          body: { name },
        }),
      ),
    deleteItem: async (workspaceId, id) =>
      unwrapBody(
        await api.DELETE(`${base}/{id}`, {
          params: { path: { workspaceId, id } },
        }),
      ),
    deleteFolder: async (workspaceId, id) =>
      unwrapBody(
        await api.DELETE(`${base}/folders/{id}`, {
          params: { path: { workspaceId, id } },
        }),
      ),
  },
});

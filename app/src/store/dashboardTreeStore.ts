import { api, unwrapBody } from "../api";
import {
  createResourceTreeStore,
  type ResourceTreeEntry,
  type TreeAccessLevel,
} from "./lib/createResourceTreeStore";

export type DashboardAccessLevel = TreeAccessLevel;
export type DashboardEntry = ResourceTreeEntry;

const base = "/api/workspaces/{workspaceId}/dashboards" as const;

/** The dashboards tree: entry type + endpoints; mechanics in the factory. */
export const useDashboardTreeStore = createResourceTreeStore<DashboardEntry>({
  resourceName: "dashboard",
  endpoints: {
    fetch: async workspaceId => {
      const data = unwrapBody(
        await api.GET(base, { params: { path: { workspaceId } } }),
      ) as {
        myDashboards?: DashboardEntry[];
        workspaceDashboards?: DashboardEntry[];
      };
      return {
        my: data.myDashboards ?? [],
        workspace: data.workspaceDashboards ?? [],
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
    // A dashboard's display name is its `title`; folders have a `name`.
    renameItem: async (workspaceId, id, name) =>
      unwrapBody(
        await api.PUT(`${base}/{id}`, {
          params: { path: { workspaceId, id } },
          body: { title: name },
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

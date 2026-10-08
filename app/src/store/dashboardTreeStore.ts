import { api, unwrapBody } from "../api";
import { renameObject } from "../lib/object-links";
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
    // The graceful-rename service (api/src/rename): the same function the
    // agent's `rename_object` uses. A bare `PUT { title }` was a full save —
    // it created a version and PUBLISHED the working definition, so renaming
    // a dashboard in the tree silently shipped its unpublished edits.
    //
    // The open tab follows at once (the rename's realtime poke does too,
    // when it arrives): its label, and — edited or not — its title and
    // version, so its next save neither conflicts nor writes the old title.
    renameItem: async (workspaceId, id, name) => {
      const result = await renameObject(workspaceId, "dashboard", {
        ref: id,
        title: name,
      });
      const title = result.after.title ?? name;
      const [{ useDashboardStore }, { syncDashboardTabTitle }] =
        await Promise.all([
          import("./dashboardStore"),
          import("../dashboard-runtime/shell"),
        ]);
      syncDashboardTabTitle(id, title);
      useDashboardStore.setState(state => {
        const entry = state.dashboards[workspaceId]?.find(d => d._id === id);
        if (entry) entry.title = title;
      });
      await useDashboardStore.getState().syncRemoteDashboard(workspaceId, id);
      return result;
    },
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

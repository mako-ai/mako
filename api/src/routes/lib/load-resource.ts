/**
 * Loading a workspace-scoped resource by route param — the one shape every
 * router used to write for itself: validate the ids, `findOne({ _id,
 * workspaceId })`, null when absent. consoles and dashboards had
 * byte-identical copies, dbt had a third with a different param name, and
 * flows wrote the query inline nineteen times.
 */
import { Types, type Model } from "mongoose";
import type { AuthenticatedContext } from "../../middleware/workspace.middleware";

/** `findOne({ _id, workspaceId })` with id validation — null when absent. */
export function findInWorkspace<T>(model: Model<T>) {
  return async (workspaceId: string | undefined, id: string | undefined) => {
    if (
      !workspaceId ||
      !id ||
      !Types.ObjectId.isValid(workspaceId) ||
      !Types.ObjectId.isValid(id)
    ) {
      return null;
    }
    return model.findOne({
      _id: new Types.ObjectId(id),
      workspaceId: new Types.ObjectId(workspaceId),
    });
  };
}

/**
 * The route-param flavour: `c.req.param("workspaceId")` + `c.req.param(idParam)`.
 * Matches the `load` contract of collaborator-routes / public-share-routes.
 */
export function workspaceResourceLoader<T>(model: Model<T>, idParam = "id") {
  const find = findInWorkspace(model);
  return (c: AuthenticatedContext) =>
    find(c.req.param("workspaceId"), c.req.param(idParam));
}

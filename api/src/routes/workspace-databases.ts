/**
 * Workspace database routes, mounted at /api/workspaces/:workspaceId/databases
 * (and the workspace-level query endpoint at .../execute). Each concern is a
 * sub-router under ./workspace-databases/; this module mounts them, in the
 * order the routes were registered when they lived in one file.
 */
import { createRouter } from "../openapi/core";
import { mongoCollectionRoutes } from "./workspace-databases/collections";
import { connectionRoutes } from "./workspace-databases/connections";
import { demoDatabaseRoutes } from "./workspace-databases/demo";
import {
  connectionExecuteRoutes,
  workspaceExecuteRoutes,
} from "./workspace-databases/execute";
import { connectionWriterRoutes } from "./workspace-databases/writers";

export const workspaceDatabaseRoutes = createRouter();

workspaceDatabaseRoutes.route("/", demoDatabaseRoutes);
workspaceDatabaseRoutes.route("/", connectionRoutes);
workspaceDatabaseRoutes.route("/", connectionWriterRoutes);
workspaceDatabaseRoutes.route("/", connectionExecuteRoutes);
workspaceDatabaseRoutes.route("/", mongoCollectionRoutes);

export { workspaceExecuteRoutes };

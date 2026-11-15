/**
 * Sharing (collaborators + general access) through the shared registrars
 * in `lib/collaborator-routes.ts`.
 */
import { SavedConsole } from "../../database/workspace-schema";
import { createRouter } from "../../openapi/core";
import {
  registerCollaboratorRoutes,
  registerSharingSettingsRoutes,
} from "../lib/collaborator-routes";
import { workspaceResourceLoader } from "../lib/load-resource";

export const consoleSharingRoutes = createRouter();

const loadConsoleById = workspaceResourceLoader(SavedConsole);

registerCollaboratorRoutes(consoleSharingRoutes, {
  resourceName: "Console",
  load: loadConsoleById,
});
registerSharingSettingsRoutes(consoleSharingRoutes, {
  resourceName: "Console",
  load: loadConsoleById,
});

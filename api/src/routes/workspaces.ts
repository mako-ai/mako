/**
 * /api/workspaces — the workspace itself and who may use it.
 *
 * Each concern is its own sub-router under ./workspaces/; this file mounts
 * them in one table. Mount order is match order: the caller-scoped static
 * paths (/pending-invites, /current, /invites/{token}) are registered before
 * GET /{id}, which would otherwise swallow them.
 *
 * Auth: every route declares its own middleware (session or API key, then
 * workspace membership/role where the route is workspace-scoped).
 */
import { createRouter } from "../openapi/core";
import { accountWorkspaceRoutes } from "./workspaces/account";
import { workspaceAccessSettingsRoutes } from "./workspaces/access-settings";
import { workspaceAgentAccessRoutes } from "./workspaces/agent-access";
import { workspaceApiKeyRoutes } from "./workspaces/api-keys";
import { workspaceInviteRoutes } from "./workspaces/invites";
import { workspaceMemberRoutes } from "./workspaces/members";
import { workspaceByIdRoutes } from "./workspaces/workspace";

export { WORKSPACE_NAME_MAX } from "./workspaces/schemas";

export const workspaceRoutes = createRouter();

workspaceRoutes.route("/", accountWorkspaceRoutes);
workspaceRoutes.route("/", workspaceByIdRoutes);
workspaceRoutes.route("/", workspaceMemberRoutes);
workspaceRoutes.route("/", workspaceAccessSettingsRoutes);
workspaceRoutes.route("/", workspaceInviteRoutes);
workspaceRoutes.route("/", workspaceApiKeyRoutes);
workspaceRoutes.route("/", workspaceAgentAccessRoutes);

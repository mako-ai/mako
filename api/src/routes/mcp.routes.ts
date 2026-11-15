/**
 * MCP server admin + grants routes.
 *
 * Mounted at `/api/workspaces/:workspaceId/mcp-servers` (authenticated,
 * workspace-scoped — same access pattern as skills.ts). Server CRUD and
 * shared-credential management require the workspace owner/admin role;
 * per-user credentials and grants are managed by each member for themselves.
 * The access middleware is here; the routes are in ./mcp/.
 *
 * A small public catalog route (`/api/mcp/presets`, ./mcp/presets.ts)
 * exposes the preset metadata that drives the "Add MCP server" form.
 */
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { createRouter } from "../openapi/core";
import { mcpServerRoutes } from "./mcp/servers";
import { mcpServerConnectionRoutes } from "./mcp/connection";
import { mcpGrantRoutes } from "./mcp/grants";
import { requireWorkspaceAccess } from "./lib/workspace-access";

export { mcpPresetRoutes } from "./mcp/presets";

// ---------------------------------------------------------------------------
// Workspace-scoped server CRUD + credentials + grants
// ---------------------------------------------------------------------------

export const mcpRoutes = createRouter();

mcpRoutes.use("*", unifiedAuthMiddleware);

// Workspace access check — mirrors skills.ts
mcpRoutes.use("*", requireWorkspaceAccess());

mcpRoutes.route("/", mcpServerRoutes);
mcpRoutes.route("/", mcpServerConnectionRoutes);
mcpRoutes.route("/", mcpGrantRoutes);

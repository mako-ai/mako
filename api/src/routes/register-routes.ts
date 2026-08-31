import type { OpenAPIHono } from "@hono/zod-openapi";

import type { AuthEnv } from "../openapi/core";
import { consoleRoutes } from "./consoles";
import { realtimeRoutes } from "./realtime";
import { dataSourceRoutes } from "./sources";
import { customPromptRoutes } from "./custom-prompt";
import { skillsRoutes } from "./skills";
import { dbtRoutes } from "./dbt.routes";
import { githubRoutes } from "./github.routes";
import { chatsRoutes } from "./chats";
import { chatImagesRoutes } from "./chat-images";
import { agentRoutes } from "./agent.routes";
import { adminRoutes } from "./admin.routes";
import { authRoutes } from "../auth/auth.controller";
import { workspaceRoutes } from "./workspaces";
import {
  workspaceDatabaseRoutes,
  workspaceExecuteRoutes,
} from "./workspace-databases";
import { connectorRoutes } from "./connectors";
import { databaseSchemaRoutes } from "./database-schemas";
import { databaseTreeRoutes } from "./database-tree";
import { flowRoutes } from "./flows";
import { usageRoutes } from "./usage";
import { billingRoutes } from "./billing";
import { stripeWebhookRoutes } from "./stripe-webhook";
import { dashboardRoutes } from "./dashboards";
import { notebookDataRoutes } from "./notebook-data";
import { notebookRoutes } from "./notebooks";
import { notebookSessionRoutes } from "./notebook-sessions";
import { publicShareRoutes } from "./public-share";
import { dashboardMaterializationRoutes } from "./dashboard-materialization";
import { resourceDataSourceRoutes } from "./resource-data-sources";
import { scheduledQueryRoutes } from "./scheduled-queries";
import { notificationRulesRoutes } from "./notification-rules";
import { devEmailPreviewRoutes } from "./dev-email-preview.routes";
import { webhookRoutes } from "./webhooks";
import { mcpPresetRoutes, mcpRoutes } from "./mcp.routes";
import { mcpProtocolRoutes } from "./mcp-server.routes";
import { mcpOAuthRoutes } from "./mcp-oauth.routes";
import { appsRoutes } from "./apps";
import { workspaceRepoRoutes } from "./workspace-repo";
import { appsGitRoutes } from "./apps-git";
import { appsBoxRoutes } from "./apps-box";
import { appsPreviewRoutes } from "./apps-preview";

/**
 * Mounts every REST router onto the provided Hono app.
 *
 * This is the single source of truth for the REST surface area and is shared
 * by both the live server (`src/index.ts`) and the OpenAPI generator
 * (`src/openapi/document.ts`). Keeping the mount table here means the generated
 * API documentation can never drift from the routes the server actually serves.
 *
 * Non-REST handlers (Inngest, health/version probes, static SPA fallback) are
 * intentionally registered directly in `src/index.ts` and are not part of the
 * documented surface.
 */
export function registerApiRoutes(app: OpenAPIHono<AuthEnv>): void {
  app.route("/api/auth", authRoutes);
  app.route("/api/workspaces", workspaceRoutes);
  app.route("/api/workspaces/:workspaceId/databases", workspaceDatabaseRoutes);
  app.route("/api/workspaces/:workspaceId/execute", workspaceExecuteRoutes);
  app.route("/api/workspaces/:workspaceId/consoles", consoleRoutes);
  app.route("/api/workspaces/:workspaceId/realtime", realtimeRoutes);
  app.route("/api/workspaces/:workspaceId/chats", chatsRoutes);
  app.route("/api/workspaces/:workspaceId/chat-images", chatImagesRoutes);
  app.route("/api/workspaces/:workspaceId/custom-prompt", customPromptRoutes);
  app.route("/api/workspaces/:workspaceId/skills", skillsRoutes);
  app.route("/api/workspaces/:workspaceId/dbt", dbtRoutes);
  // GitHub App install callback (session-authed, workspace via state param).
  app.route("/api/github", githubRoutes);
  app.route("/api/workspaces/:workspaceId/connectors", dataSourceRoutes);
  app.route("/api/workspaces/:workspaceId/flows", flowRoutes);
  app.route(
    "/api/workspaces/:workspaceId/scheduled-queries",
    scheduledQueryRoutes,
  );
  app.route(
    "/api/workspaces/:workspaceId/notification-rules",
    notificationRulesRoutes,
  );
  app.route("/api/workspaces/:workspaceId/mcp-servers", mcpRoutes);
  // Intentionally public: static preset metadata for the "Add MCP server" form.
  app.route("/api/mcp", mcpPresetRoutes);
  // Mako's own MCP endpoint (POST /api/mcp, API-key authed, JSON-RPC not REST).
  app.route("/api/mcp", mcpProtocolRoutes);
  // OAuth 2.1 AS so MCP clients can connect with just the URL (sign-in flow);
  // the /.well-known discovery documents are mounted at root in src/index.ts.
  app.route("/api/oauth/mcp", mcpOAuthRoutes);

  if (process.env.NODE_ENV !== "production") {
    app.route("/api/dev/email-preview", devEmailPreviewRoutes);
  }

  app.route("/api/workspaces/:workspaceId/usage", usageRoutes);
  app.route("/api/workspaces/:workspaceId/billing", billingRoutes);
  app.route("/api/workspaces/:workspaceId/dashboards", dashboardRoutes);
  app.route("/api/workspaces/:workspaceId/notebook", notebookDataRoutes);
  app.route("/api/workspaces/:workspaceId/notebooks", notebookRoutes);
  app.route("/api/workspaces/:workspaceId/notebooks", notebookSessionRoutes);
  // Apps (git-backed) — parallel to v1, always available (no feature flag).
  app.route("/api/workspaces/:workspaceId/apps", appsRoutes);
  // The workspace repo itself (status, branches, commits, GitHub connect) —
  // the repo is workspace infrastructure; apps/consoles/dbt are lenses on it.
  app.route("/api/workspaces/:workspaceId/repo", workspaceRepoRoutes);
  app.route("/api/apps-preview", appsPreviewRoutes);
  // Intentionally public: the workspace repo over git's own HTTP protocol,
  // authorized by a scoped `mgt_` token. This is what makes a sandbox a
  // normal machine with a normal remote.
  app.route("/api/apps-git", appsGitRoutes);
  // Also public, same token: processes inside a sandbox reporting the box's
  // own state (branch, dirty files, dev servers) the moment it changes.
  app.route("/api/apps-box", appsBoxRoutes);
  // Legacy aliases from before the apps-v2 → apps rename. Live sandboxes have
  // the old git-remote URL baked into their clones, and already-running box
  // agents post state to the old box path; both must keep working until every
  // box from before the rename has been recycled.
  app.route("/api/apps-v2-git", appsGitRoutes);
  app.route("/api/apps-v2-box", appsBoxRoutes);
  app.route(
    "/api/workspaces/:workspaceId/data-sources",
    resourceDataSourceRoutes,
  );
  app.route(
    "/api/workspaces/:workspaceId/dashboards/:dashboardId",
    dashboardMaterializationRoutes,
  );
  // Intentionally public: token-gated read-only shares (dashboards + apps).
  app.route("/api/share", publicShareRoutes);
  app.route("/api/agent", agentRoutes);
  app.route("/api/admin", adminRoutes);
  app.route("/api/connectors", connectorRoutes);
  app.route("/api/databases", databaseSchemaRoutes);
  app.route("/api/workspaces/:workspaceId/databases", databaseTreeRoutes);
  app.route("/api", webhookRoutes);
  app.route("/api/webhooks/stripe", stripeWebhookRoutes);
}

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
import { appRoutes } from "./apps";
import { appsV2Routes } from "./apps-v2";
import { publicShareRoutes } from "./public-share";
import { dashboardMaterializationRoutes } from "./dashboard-materialization";
import { resourceDataSourceRoutes } from "./resource-data-sources";
import { scheduledQueryRoutes } from "./scheduled-queries";
import { notificationRulesRoutes } from "./notification-rules";
import { devEmailPreviewRoutes } from "./dev-email-preview.routes";
import { webhookRoutes } from "./webhooks";
import { mcpPresetRoutes, mcpRoutes } from "./mcp.routes";

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

  if (process.env.NODE_ENV !== "production") {
    app.route("/api/dev/email-preview", devEmailPreviewRoutes);
  }

  app.route("/api/workspaces/:workspaceId/usage", usageRoutes);
  app.route("/api/workspaces/:workspaceId/billing", billingRoutes);
  app.route("/api/workspaces/:workspaceId/dashboards", dashboardRoutes);
  app.route("/api/workspaces/:workspaceId/apps", appRoutes);
  app.route("/api/workspaces/:workspaceId/apps-v2", appsV2Routes);
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

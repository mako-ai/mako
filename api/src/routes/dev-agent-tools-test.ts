/**
 * TEMPORARY DEV-ONLY route for manually exercising the server-side console
 * tools from inside the API process (so realtime pokes reach connected
 * browser tabs with the in-memory pub/sub backend). NOT FOR COMMIT — removed
 * after issue #475 testing.
 */
import { Hono } from "hono";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import { workspaceService } from "../services/workspace.service";
import { createServerConsoleTools } from "../agent-lib/tools/server-console-tools";

export const devAgentToolsTestRoutes = new Hono();

devAgentToolsTestRoutes.use("*", unifiedAuthMiddleware);

// POST /api/dev/agent-tools/:workspaceId  { tool, input, chatId }
devAgentToolsTestRoutes.post(
  "/:workspaceId",
  async (c: AuthenticatedContext) => {
    const workspaceId = c.req.param("workspaceId");
    const user = c.get("user");
    if (!user || !(await workspaceService.hasAccess(workspaceId, user.id))) {
      return c.json({ success: false, error: "Access denied" }, 403);
    }
    const { tool, input, chatId } = await c.req.json();
    const tools = createServerConsoleTools({
      workspaceId,
      userId: user.id,
      chatId,
    }) as Record<
      string,
      { execute?: (input: unknown, opts: unknown) => Promise<unknown> }
    >;
    const target = tools[tool];
    if (!target?.execute) {
      return c.json({ success: false, error: `Unknown tool ${tool}` }, 400);
    }
    const output = await target.execute(input, {
      toolCallId: "dev",
      messages: [],
    });
    return c.json({ success: true, output });
  },
);

import { Next } from "hono";
import { workspaceService } from "../services/workspace.service";
import { AuthenticatedContext } from "./workspace.middleware";

export async function requireWorkspaceAdmin(
  c: AuthenticatedContext,
  next: Next,
) {
  const workspaceId = c.req.param("workspaceId");
  const user = c.get("user");

  if (!workspaceId || !user?.id) {
    return c.json({ success: false, error: "Unauthorized" }, 401);
  }

  const member = await workspaceService.getMember(workspaceId, user.id);
  const isAdmin = member?.role === "owner" || member?.role === "admin";

  if (!isAdmin) {
    return c.json(
      { success: false, error: "Admin access required for scheduled queries" },
      403,
    );
  }

  await next();
}

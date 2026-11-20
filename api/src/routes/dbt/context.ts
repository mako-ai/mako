/**
 * Helpers shared by the dbt sub-routers: the caller, the error envelope
 * (RepoRequiredError → 412, protected environment → 400), realtime pokes and
 * the project loader. Access checks run once, in ../dbt.routes.ts.
 */
import { workspaceResourceLoader } from "../lib/load-resource";
import { RepoRequiredError } from "../../apps/config";
import { loggers } from "../../logging";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { DbtProject } from "../../database/workspace-schema";
import { publishRealtimeEvent } from "../../services/realtime.service";
import { DbtProtectedEnvironmentError } from "../../dbt/dbt-environments.service";
import { fail } from "../lib/respond";
import { actorFromRequest, type DbtRunActor } from "../../dbt/run-actor";

export const logger = loggers.api("dbt");

export function getUserId(c: AuthenticatedContext): string {
  return c.get("user")?.id ?? "api-key";
}

/**
 * Who this request is, for `dbt_runs.actor`: the signed-in person, or the
 * workspace API key / MCP client behind the call (never its secret).
 */
export function runActorOf(c: AuthenticatedContext): DbtRunActor {
  return actorFromRequest({
    authType: c.get("authType"),
    user: c.get("user"),
    apiKey: c.get("apiKey"),
    mcpOAuthClientId: c.get("mcpOAuthClientId"),
    mcpAgentSessionId: c.get("mcpAgentSessionId"),
  });
}

export function badRequest(c: AuthenticatedContext, message: string) {
  return fail(c, 400, message);
}

export function serverError(
  c: AuthenticatedContext,
  error: unknown,
  fallback: string,
) {
  if (error instanceof RepoRequiredError) {
    return fail(c, error.status as 412, error.message, { code: error.code });
  }
  if (error instanceof DbtProtectedEnvironmentError) {
    return fail(c, 400, error.message);
  }
  logger.error(fallback, { error });
  return fail(c, 500, error instanceof Error ? error.message : fallback);
}

/**
 * Realtime pokes so every open window (this user's and, for committed/base
 * changes, other users') refreshes without a manual reload — the same
 * poke-then-pull channel the agent's server tools use.
 */
export function publishDbtEvent(
  c: AuthenticatedContext,
  event: Parameters<typeof publishRealtimeEvent>[1],
): void {
  const workspaceId = c.req.param("workspaceId");
  if (workspaceId) publishRealtimeEvent(workspaceId, event);
}

export const findProject = workspaceResourceLoader(DbtProject, "projectId");

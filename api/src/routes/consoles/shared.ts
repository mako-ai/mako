/**
 * What every console sub-router shares: the logger, the request schemas
 * every route repeats, and the error answers (the repo gate, the
 * session-only refusal, the catch-all 500).
 */
import { z } from "@hono/zod-openapi";
import type { Context } from "hono";
import { RepoRequiredError } from "../../apps/config";
import { loggers } from "../../logging";
import { jsonBody, pathParam } from "../../openapi/core";
import { fail } from "../lib/respond";

export const logger = loggers.api("consoles");

export const wsParams = z.object({ workspaceId: pathParam("workspaceId") });

export const consoleIdParams = z.object({
  workspaceId: pathParam("workspaceId"),
  id: pathParam("id"),
});

/** An optional free-form JSON body (validated by the handler). */
export const looseJsonBody = jsonBody(z.record(z.string(), z.any()), true);

/** The production gate (apps.md §17): no connected repo, no save. */
export function repoRequired(c: Context, error: RepoRequiredError) {
  return fail(c, error.status as 412, error.message, { code: error.code });
}

/**
 * Workspace access itself is the router middleware's job (it ran and set
 * memberRole); routes that need a person (not an API key) refuse here.
 */
export function accessDenied(c: Context) {
  return fail(c, 403, "Access denied to workspace");
}

/** GET/list without a GitHub binding is an empty explorer, not 412. */
export function emptyConsoleTree() {
  return {
    success: true as const,
    myConsoles: [] as never[],
    sharedWithWorkspace: [] as never[],
    tree: [] as never[],
  };
}

/**
 * The catch-all answer: the repo gate as 412, anything else logged and a
 * 500 carrying the error's message (or `fallback`).
 */
export function serverError(
  c: Context,
  error: unknown,
  logMessage: string,
  fallback: string,
  context?: Record<string, unknown>,
) {
  if (error instanceof RepoRequiredError) return repoRequired(c, error);
  logger.error(logMessage, { ...context, error });
  return fail(c, 500, error instanceof Error ? error.message : fallback);
}

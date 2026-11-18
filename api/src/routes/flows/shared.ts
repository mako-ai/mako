/**
 * Helpers every flow sub-router shares: the repo gate and write-through
 * (RFC #904), the owner/admin check, the route-spec builder, and the error
 * mapping for {@link FlowRequestError}.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import type { ContentfulStatusCode } from "hono/utils/http-status";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  type AuthEnv,
} from "../../openapi/core";
import { Flow } from "../../database/workspace-schema";
import { commitFlowFile } from "../../services/flow-config.service";
import { RepoRequiredError, appsRequireConnectedRepo } from "../../apps/config";
import { requireWorkspaceRepo } from "../../apps/workspace-repo-required";
import { resolveMirrorTarget } from "../../apps/cloud-repo.service";
import { workspaceService } from "../../services/workspace.service";
import type { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { FlowRequestError } from "../../services/flow-request-error";
import { loggers } from "../../logging";
import { findInWorkspace } from "../lib/load-resource";
import { fail } from "../lib/respond";

export type FlowRouter = OpenAPIHono<AuthEnv>;

/** `findOne({ _id, workspaceId })` for flows — was written inline sixteen times. */
export const findFlow = findInWorkspace(Flow);

export const logger = loggers.inngest("flow");

/**
 * RFC #904 decision 1: a connected repo is REQUIRED for flows.
 *
 * `flows/<slug>.yml` is the definition, so a workspace without a repo has
 * nowhere durable to keep one — there is no Mongo fallback and no second
 * definition path. Flows follow consoles and dbt into `RepoRequiredError`
 * rather than silently writing a definition that only exists in a database
 * (apps.md §17).
 *
 * Deciding it now costs one workspace's configuration — ours, which has a
 * repo — and stops being free the moment flows have external users. That is
 * the opposite of the position consoles were in when they hit this.
 */
/**
 * Write the definition to its file first, then the caller persists the
 * derived index. A failed commit fails the request — git is the store.
 */
export async function commitFlowFileOrFail(
  c: AuthenticatedContext,
  flow: Parameters<typeof commitFlowFile>[0],
  actorUserId?: string,
): Promise<Response | null> {
  const result = await commitFlowFile(flow, actorUserId);
  if (result.ok) {
    if (result.sourceBlobSha) flow.sourceBlobSha = result.sourceBlobSha;
    // Assigning undefined to a nested path and saving persists `{}`, which
    // the overlay used to read as "invalid". Unset the marker instead; a
    // not-yet-saved flow has no row to unset, which is fine.
    await Flow.updateOne(
      { _id: flow._id },
      { $unset: { definitionInvalid: 1 } },
    );
    return null;
  }
  logger.error("Flow definition did not reach the workspace repo", {
    workspaceId: flow.workspaceId.toString(),
    slug: flow.slug,
    error: result.error,
  });
  if (result.conflict) {
    return fail(
      c,
      409,
      "The flow file at main changed since this flow was read, so nothing was saved. Reload the flow and apply the change again.",
      { code: "definition_conflict", detail: result.error },
    );
  }
  return fail(
    c,
    502,
    "The flow definition could not be written to the workspace repo, so nothing was saved. Retry the change; if it keeps failing, check the GitHub connection.",
    { code: "definition_not_committed", detail: result.error },
  );
}

export async function assertFlowRepo(workspaceId: string): Promise<void> {
  await requireWorkspaceRepo(workspaceId);
  if (appsRequireConnectedRepo() && !(await resolveMirrorTarget(workspaceId))) {
    throw new RepoRequiredError();
  }
}

/** 412 with the actionable message, as consoles and the prompt already do. */
export function repoRequired(
  c: AuthenticatedContext,
  error: RepoRequiredError,
) {
  return fail(c, error.status as 412, error.message, { code: error.code });
}

export async function assertOwnerOrAdmin(
  c: AuthenticatedContext,
  workspaceId: string,
) {
  const user = c.get("user");
  if (!user) {
    return fail(c, 403, "Owner/admin access requires user session");
  }

  const isOwnerOrAdmin = await workspaceService.hasRole(workspaceId, user.id, [
    "owner",
    "admin",
  ]);
  if (!isOwnerOrAdmin) {
    return fail(c, 403, "Owner/admin role required");
  }

  return null;
}

/** The message flow routes have always put in a failure body for a throw. */
export function thrownMessage(error: unknown): string {
  return error instanceof Error ? error.message : "Unknown error";
}

/**
 * The failure for a throw from a flow handler: a {@link FlowRequestError}
 * answers with its own status and body; anything else with `fallbackStatus`
 * and its message (the historical contract of these routes).
 */
export function flowFailure(
  c: AuthenticatedContext,
  error: unknown,
  fallbackStatus: ContentfulStatusCode,
) {
  if (error instanceof FlowRequestError) {
    return fail(c, error.status, error.message, error.extra);
  }
  return fail(c, fallbackStatus, thrownMessage(error));
}

const pathParam = (name: string) =>
  z.string().openapi({ param: { name, in: "path" } });

/** An optional string query parameter, as every flow query param is declared. */
export const queryParam = (name: string) =>
  z
    .string()
    .optional()
    .openapi({ param: { name, in: "query" } });

/** The untyped JSON body most flow mutations accept. */
export const ANY_JSON_BODY = {
  required: false,
  content: {
    "application/json": { schema: z.record(z.string(), z.any()) },
  },
};

type FlowRouteRequest = {
  query?: z.ZodObject;
  body?: {
    required: boolean;
    content: { "application/json": { schema: z.ZodType } };
  };
};

/**
 * The `createRoute` config every flow route used to spell out: tag `Flows`,
 * summary `"<METHOD> <path>"`, session/API-key security, the permissive
 * response set, and one string path param per `{name}` in the path (after
 * `workspaceId`, which every route is mounted under).
 */
export function flowRoute<
  M extends "get" | "post" | "put" | "delete",
  P extends string,
>(method: M, path: P, request: FlowRouteRequest = {}) {
  const names = [...path.matchAll(/\{(\w+)\}/g)].map(match => match[1]);
  const params = z.object(
    Object.fromEntries(
      ["workspaceId", ...names].map(name => [name, pathParam(name)]),
    ) as Record<string, z.ZodString>,
  );
  return createRoute({
    method,
    path,
    tags: ["Flows"],
    summary: `${method.toUpperCase()} ${path}`,
    security: AUTH_SECURITY,
    request: { params, ...request },
    responses: { ...OPEN_RESPONSES },
  });
}

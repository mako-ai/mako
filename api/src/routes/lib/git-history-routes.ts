/**
 * The four git-history routes every History popover reads, for one entity
 * kind: list, what one commit changed, a file before/after a commit, and
 * restore-as-new-commit (apps.md §16). Consoles and notebooks predate this
 * and register their own; flows and workspace connectors use it.
 *
 * The kind supplies only how to find the entity (and whether the caller may
 * write it) and how to restore it. The scope it returns is also the access
 * check for file reads — see `entity-git-history.ts`.
 */
import { createRoute, z, type OpenAPIHono } from "@hono/zod-openapi";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  jsonBody,
  type AuthEnv,
} from "../../openapi/core";
import type { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { RepoRequiredError } from "../../apps/config";
import {
  NotEntityPathError,
  entityCommitChanges,
  entityFileVersions,
  entityHistory,
  type EntityGitScope,
} from "../../apps/entity-git-history";
import { RestoreRefusedError } from "../../services/repo-entity-restore.service";
import { loggers } from "../../logging";

const logger = loggers.api("git-history-routes");

const Sha = z.string().regex(/^[0-9a-f]{7,40}$/);
const RepoPath = z
  .string()
  .min(1)
  .max(4096)
  .refine(
    p => !p.startsWith("/") && !p.split("/").includes(".."),
    "path must stay inside the repository",
  );

export interface GitHistoryEntity {
  scope: EntityGitScope;
  /** Undefined for API-key callers; commits then carry the default author. */
  userId?: string;
  workspaceId: string;
}

export interface GitHistoryKind<E extends GitHistoryEntity> {
  /** OpenAPI tag, e.g. "Flows". */
  tag: string;
  /** Singular noun for summaries and errors, e.g. "flow". */
  noun: string;
  /** Path parameter naming the entity, e.g. "flowId". */
  idParam: string;
  /** Prefix under the router, e.g. "/{flowId}/git" → `/{flowId}/git/history`. */
  base: string;
  /** Find the entity; a Response is returned as-is (404/403). */
  load: (
    c: AuthenticatedContext,
    opts: { write: boolean },
  ) => Promise<E | Response>;
  restore: (entity: E, sha: string) => Promise<Record<string, unknown>>;
}

function failure(
  c: AuthenticatedContext,
  error: unknown,
  noun: string,
  action: string,
) {
  if (error instanceof RepoRequiredError) {
    return c.json(
      { success: false, code: error.code, error: error.message },
      error.status as 412,
    );
  }
  if (error instanceof NotEntityPathError) {
    return c.json({ success: false, error: `Path is not this ${noun}` }, 403);
  }
  if (error instanceof RestoreRefusedError) {
    return c.json({ success: false, error: error.message }, 400);
  }
  logger.error(`Failed to ${action} (${noun})`, { error });
  return c.json(
    {
      success: false,
      error: error instanceof Error ? error.message : `Failed to ${action}`,
    },
    500,
  );
}

export function registerGitHistoryRoutes<E extends GitHistoryEntity>(
  router: OpenAPIHono<AuthEnv>,
  kind: GitHistoryKind<E>,
) {
  const params = z.object({
    workspaceId: z
      .string()
      .openapi({ param: { name: "workspaceId", in: "path" } }),
    [kind.idParam]: z
      .string()
      .openapi({ param: { name: kind.idParam, in: "path" } }),
  });

  router.openapi(
    createRoute({
      method: "get",
      path: `${kind.base}/history`,
      tags: [kind.tag],
      summary: `Commit history of a ${kind.noun} (its files in the workspace repo)`,
      security: AUTH_SECURITY,
      request: {
        params,
        query: z.object({
          limit: z.coerce.number().int().positive().max(200).optional(),
        }),
      },
      responses: { ...OPEN_RESPONSES },
    }),
    async c => {
      const ctx = c as AuthenticatedContext;
      try {
        const entity = await kind.load(ctx, { write: false });
        if (entity instanceof Response) return entity;
        const { limit } = c.req.valid("query");
        const commits = await entityHistory(entity.scope, limit ?? 50);
        return c.json({
          success: true as const,
          commits,
          path: entity.scope.pathspec,
        });
      } catch (error) {
        return failure(ctx, error, kind.noun, "list history");
      }
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: `${kind.base}/commit`,
      tags: [kind.tag],
      summary: `What one commit changed for this ${kind.noun}`,
      security: AUTH_SECURITY,
      request: { params, query: z.object({ sha: Sha }) },
      responses: { ...OPEN_RESPONSES },
    }),
    async c => {
      const ctx = c as AuthenticatedContext;
      try {
        const entity = await kind.load(ctx, { write: false });
        if (entity instanceof Response) return entity;
        const { sha } = c.req.valid("query");
        const commit = await entityCommitChanges(entity.scope, sha);
        return c.json({ success: true as const, commit });
      } catch (error) {
        return failure(ctx, error, kind.noun, "read the commit");
      }
    },
  );

  router.openapi(
    createRoute({
      method: "get",
      path: `${kind.base}/file-versions`,
      tags: [kind.tag],
      summary: `A ${kind.noun} file before and after one commit (for diffs)`,
      security: AUTH_SECURITY,
      request: { params, query: z.object({ sha: Sha, path: RepoPath }) },
      responses: { ...OPEN_RESPONSES },
    }),
    async c => {
      const ctx = c as AuthenticatedContext;
      try {
        const entity = await kind.load(ctx, { write: false });
        if (entity instanceof Response) return entity;
        const { sha, path } = c.req.valid("query");
        const versions = await entityFileVersions(entity.scope, sha, path);
        return c.json({ success: true as const, versions });
      } catch (error) {
        return failure(ctx, error, kind.noun, "read the diff");
      }
    },
  );

  router.openapi(
    createRoute({
      method: "post",
      path: `${kind.base}/restore`,
      tags: [kind.tag],
      summary: `Restore a ${kind.noun} to a previous commit (as a new commit)`,
      description: `Puts the ${kind.noun}'s files back to their content at \`sha\` and commits that on main, then applies it as a push would. Nothing is rewritten: the versions in between stay in the history.`,
      security: AUTH_SECURITY,
      request: { params, body: jsonBody(z.object({ sha: Sha })) },
      responses: { ...OPEN_RESPONSES },
    }),
    async c => {
      const ctx = c as AuthenticatedContext;
      try {
        const entity = await kind.load(ctx, { write: true });
        if (entity instanceof Response) return entity;
        const { sha } = c.req.valid("json");
        const result = await kind.restore(entity, sha);
        return c.json({ success: true as const, result });
      } catch (error) {
        return failure(ctx, error, kind.noun, "restore");
      }
    },
  );
}

/**
 * Publishing (§13.3) and rollback.
 */
import { createRoute, z } from "@hono/zod-openapi";
import {
  publishApp,
  rollbackApp,
  type PublishRefusal,
} from "../../apps/app-publish.service";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { fail } from "../lib/respond";
import {
  ProjectParam,
  commitAuthorOf,
  handleError,
  loadProject,
} from "./shared";

export const appsPublishRoutes = createRouter();

/** A refused publish or rollback, with the build/push output when there is one. */
function refused(c: AuthenticatedContext, outcome: PublishRefusal) {
  return fail(
    c,
    outcome.status,
    outcome.error,
    outcome.output !== undefined ? { output: outcome.output } : undefined,
  );
}

// ---------------------------------------------------------------------------
// Publishing (§13.3): merge → build from main → immutable artifact → repoint
// ---------------------------------------------------------------------------

appsPublishRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/publish",
    tags: ["Apps"],
    summary: "Publish the app: merge to main, build, and deploy",
    description:
      "Merges `branch` (defaulting to the caller's own branch) into main, builds from main in the sandbox, prepares every required parquet binding at that exact commit, uploads the output as an immutable deployment keyed by commit sha, and points the app at it. A failed build or binding leaves the previous deployment serving. Re-publishing an unchanged sha reuses the existing code and data artifacts instead of rebuilding them.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: false,
        content: {
          "application/json": {
            schema: z.object({
              branch: z.string().optional(),
            }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const body = c.req.valid("json") ?? {};
      const outcome = await publishApp(loaded.project, {
        userId: loaded.userId,
        branch: body.branch,
        author: commitAuthorOf(c),
      });
      if (!outcome.ok) return refused(c, outcome);
      const { sha, fileCount, reused } = outcome;
      return c.json({ success: true as const, sha, fileCount, reused }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);
appsPublishRoutes.openapi(
  createRoute({
    method: "post",
    path: "/{id}/rollback",
    tags: ["Apps"],
    summary: "Point the app at a previously published deployment",
    description:
      "Deployments are immutable and addressed by commit sha, so rolling back is a repoint — no code rebuild and no sandbox. The target sha must still have a stored deployment, and every parquet binding required by that commit is verified or rematerialized before the pointer moves.",
    security: AUTH_SECURITY,
    request: {
      params: ProjectParam,
      body: {
        required: true,
        content: {
          "application/json": {
            schema: z.object({ sha: z.string().min(7) }),
          },
        },
      },
    },
    responses: OPEN_RESPONSES,
  }),
  async c => {
    try {
      const loaded = await loadProject(c, { write: true });
      if ("errorResponse" in loaded) return loaded.errorResponse;
      const { sha } = c.req.valid("json");
      const outcome = await rollbackApp(loaded.project, sha, {
        userId: loaded.userId,
      });
      if (!outcome.ok) return refused(c, outcome);
      return c.json({ success: true as const, sha: outcome.sha }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

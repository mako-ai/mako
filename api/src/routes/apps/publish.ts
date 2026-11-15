/**
 * Publishing (§13.3) and rollback.
 */
import { markDeployStage } from "../../apps/deploy-progress";
import { createRoute, z } from "@hono/zod-openapi";
import {
  ensureProjectRow,
  PUBLISH_ACTOR,
  checkoutInBox,
  defaultBranchSha,
  ensureWorktree,
  execInWorktree,
  promoteToMain,
  trialMerge,
} from "../../apps/worktree.service";
import {
  buildApp,
  deployBuild,
  deploymentExists,
  ensureDeploymentBindings,
  recordDeployFailure,
  setPublishedSha,
} from "../../apps/deployment.service";
import {
  freshenBeforeMainWrite,
  mirrorPushNow,
} from "../../apps/cloud-repo.service";
import { updateRefCas } from "../../apps/repository.service";
import {
  AUTH_SECURITY,
  OPEN_RESPONSES,
  createRouter,
} from "../../openapi/core";
import { ProjectParam, handleError, loadProject } from "./shared";

export const appsPublishRoutes = createRouter();

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
      // Publishing is one of the three acts that give a folder-only app a
      // database row (§13.6) — without this, `setPublishedSha` below is an
      // updateOne against an _id that does not exist: the response says
      // published, nothing persists, and a reload shows "not published".
      loaded.project = await ensureProjectRow(
        loaded.project,
        loaded.userId ?? "",
      );
      const body = c.req.valid("json") ?? {};
      const user = c.get("user");
      // Merge onto the mirror's main, not this instance's cached copy of it.
      // A laptop push or a PR merge on GitHub that this instance has not seen
      // yet would otherwise make the promoted main unmirrorable (non-fast-
      // forward) and the publish fail with "could not save durably".
      await freshenBeforeMainWrite(loaded.project.workspaceId.toString());
      // Publishing means "ship MY work" — the branch the caller is actually
      // on (their worktree doc remembers it; checkout keeps it current),
      // not a computed name. On main, publish simply builds main's head.
      const callerWorktree = await ensureWorktree(
        loaded.project,
        loaded.userId ?? "api-key",
      );
      const branch = body.branch ?? callerWorktree.doc.branch;

      const handle = await ensureWorktree(loaded.project, PUBLISH_ACTOR, {
        branch: loaded.project.defaultBranch || "main",
      });

      // Compare-and-swap against the main this publish started from, so two
      // publishes racing each other fail cleanly instead of interleaving.
      const expectedMain = await defaultBranchSha(loaded.project);
      const trial = await trialMerge(
        handle,
        branch ?? (loaded.project.defaultBranch || "main"),
        user?.email ? { name: user.email, email: user.email } : undefined,
      );
      if (!trial.ok) {
        return c.json({ success: false, error: trial.reason }, 409);
      }
      const sha = trial.sha;

      // Move main to the merge NOW and mirror it, BEFORE building. The build
      // target is then a real, durable, fetchable ref — not a dangling commit
      // that a fresh serverless instance (its repo is a cache of the mirror)
      // has never seen, which is what broke publishing under load with
      // "upload-pack: not our ref". Advancing main to not-yet-built code is
      // safe: production is `publishedSha`, which only ever moves to a
      // SUCCESSFUL build — so a failed build leaves the live app untouched and
      // just shows main ahead of what is deployed. (apps.md §13.3.1)
      try {
        await promoteToMain(handle, { sha, expectedMain });
      } catch {
        return c.json(
          {
            success: false,
            error:
              "main moved while this publish was running — nothing shipped. Try again.",
          },
          409,
        );
      }
      try {
        await mirrorPushNow(loaded.project.workspaceId.toString());
      } catch (pushError) {
        // main advanced locally but the durable push (to the git mirror)
        // failed — bad credentials, GitHub down, a rejected ref. Roll main
        // back to where it was so the local repo and the durable store agree:
        // otherwise a serverless instance recycle would restore from the
        // (unchanged) mirror and silently "lose" this commit, and the sandbox
        // could no longer fetch it ("not our ref"). Nothing published; retry.
        await updateRefCas(
          handle.repoDir,
          `refs/heads/${loaded.project.defaultBranch || "main"}`,
          expectedMain,
          sha,
        ).catch(() => undefined);
        return c.json(
          {
            success: false,
            error:
              "Could not save the change durably — the push to the git mirror failed, so nothing was published. Try again.",
            output:
              pushError instanceof Error
                ? pushError.message
                : String(pushError),
          },
          502,
        );
      }

      if (await deploymentExists(loaded.project._id.toString(), sha)) {
        let refreshing: string[];
        try {
          ({ refreshing } = await ensureDeploymentBindings(
            loaded.project,
            sha,
          ));
        } catch (bindingError) {
          await recordDeployFailure(
            loaded.project,
            sha,
            "bindings",
            bindingError,
          );
          return c.json(
            {
              success: false,
              error:
                "Data binding preparation failed — the live app still serves the last successful deployment.",
              output:
                bindingError instanceof Error
                  ? bindingError.message
                  : String(bindingError),
            },
            422,
          );
        }
        await setPublishedSha(loaded.project, sha, { refreshing });
        return c.json(
          { success: true as const, sha, fileCount: 0, reused: true },
          200,
        );
      }

      // Build main (now a durable ref) and deploy on success.
      await markDeployStage(loaded.project, sha, "build");
      await checkoutInBox(handle, sha);
      const build = await buildApp(handle, execInWorktree);
      if (!build.ok) {
        await recordDeployFailure(loaded.project, sha, "build", build.output);
        return c.json(
          {
            success: false,
            error:
              "Build failed — main was updated but nothing was deployed; the live app still serves the last successful build.",
            output: build.output,
          },
          422,
        );
      }

      let refreshing: string[];
      try {
        ({ refreshing } = await ensureDeploymentBindings(loaded.project, sha));
      } catch (bindingError) {
        await recordDeployFailure(
          loaded.project,
          sha,
          "bindings",
          bindingError,
        );
        return c.json(
          {
            success: false,
            error:
              "Data binding preparation failed — main was updated but nothing was deployed; the live app still serves the last successful deployment.",
            output:
              bindingError instanceof Error
                ? bindingError.message
                : String(bindingError),
          },
          422,
        );
      }

      const result = await deployBuild(loaded.project, sha, handle, {
        bindingsReady: true,
        refreshing,
      });

      return c.json(
        {
          success: true as const,
          sha: result.sha,
          fileCount: result.fileCount,
          reused: result.reused,
        },
        200,
      );
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
      // Same reason as publish: a folder-only app has no row, and
      // setPublishedSha's updateOne would match nothing and report success.
      loaded.project = await ensureProjectRow(
        loaded.project,
        loaded.userId ?? "",
      );
      const { sha } = c.req.valid("json");
      const projectId = loaded.project._id.toString();
      if (!(await deploymentExists(projectId, sha))) {
        return c.json(
          {
            success: false,
            error: `No stored deployment for ${sha.slice(0, 7)}`,
          },
          404,
        );
      }
      let refreshing: string[];
      try {
        ({ refreshing } = await ensureDeploymentBindings(loaded.project, sha));
      } catch (bindingError) {
        await recordDeployFailure(
          loaded.project,
          sha,
          "bindings",
          bindingError,
        );
        return c.json(
          {
            success: false,
            error:
              "Rollback data preparation failed — the current live deployment was not changed.",
            output:
              bindingError instanceof Error
                ? bindingError.message
                : String(bindingError),
          },
          422,
        );
      }
      await setPublishedSha(loaded.project, sha, { refreshing });
      return c.json({ success: true as const, sha }, 200);
    } catch (error) {
      return handleError(c, error);
    }
  },
);

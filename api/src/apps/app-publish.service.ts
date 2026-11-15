/**
 * Publishing an app (§13.3): merge → build from main → immutable artifact →
 * repoint, and rolling back to an earlier deployment.
 *
 * The routes (routes/apps/publish.ts) only load the project and turn a
 * {@link PublishOutcome} into a response; everything that moves main, builds
 * or repoints lives here.
 */
import type { IAppProject } from "../database/workspace-schema";
import { freshenBeforeMainWrite, mirrorPushNow } from "./cloud-repo.service";
import {
  buildApp,
  deployBuild,
  deploymentExists,
  ensureDeploymentBindings,
  recordDeployFailure,
  setPublishedSha,
} from "./deployment.service";
import { markDeployStage } from "./deploy-progress";
import { updateRefCas } from "./repository.service";
import {
  PUBLISH_ACTOR,
  checkoutInBox,
  defaultBranchSha,
  ensureProjectRow,
  ensureWorktree,
  execInWorktree,
  promoteToMain,
  trialMerge,
} from "./worktree.service";

/** A refusal: the HTTP status and body fields the route answers with. */
export interface PublishRefusal {
  ok: false;
  status: 404 | 409 | 422 | 502;
  error: string;
  output?: string;
}

export type PublishOutcome =
  | { ok: true; sha: string; fileCount: number; reused: boolean }
  | PublishRefusal;

export type RollbackOutcome = { ok: true; sha: string } | PublishRefusal;

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/**
 * Verify or rematerialize every parquet binding `sha` requires. On failure
 * the deploy failure is recorded and nothing is repointed.
 */
async function prepareBindings(
  project: IAppProject,
  sha: string,
  failure: string,
): Promise<{ refreshing: string[] } | PublishRefusal> {
  try {
    return await ensureDeploymentBindings(project, sha);
  } catch (bindingError) {
    await recordDeployFailure(project, sha, "bindings", bindingError);
    return {
      ok: false,
      status: 422,
      error: failure,
      output: messageOf(bindingError),
    };
  }
}

/**
 * Publish `branch` (default: the branch the caller's worktree is on): merge
 * it into main, mirror main, build main in the shared publish box, prepare
 * its bindings, and point the app at the new deployment. A sha that already
 * has a stored deployment is repointed without a rebuild.
 */
export async function publishApp(
  loadedProject: IAppProject,
  opts: {
    userId?: string;
    branch?: string;
    author?: { name: string; email: string };
  },
): Promise<PublishOutcome> {
  // Publishing is one of the three acts that give a folder-only app a
  // database row (§13.6) — without this, `setPublishedSha` below is an
  // updateOne against an _id that does not exist: the response says
  // published, nothing persists, and a reload shows "not published".
  const project = await ensureProjectRow(loadedProject, opts.userId ?? "");
  const workspaceId = project.workspaceId.toString();
  const mainBranch = project.defaultBranch || "main";
  // Merge onto the mirror's main, not this instance's cached copy of it.
  // A laptop push or a PR merge on GitHub that this instance has not seen
  // yet would otherwise make the promoted main unmirrorable (non-fast-
  // forward) and the publish fail with "could not save durably".
  await freshenBeforeMainWrite(workspaceId);
  // Publishing means "ship MY work" — the branch the caller is actually
  // on (their worktree doc remembers it; checkout keeps it current),
  // not a computed name. On main, publish simply builds main's head.
  const callerWorktree = await ensureWorktree(
    project,
    opts.userId ?? "api-key",
  );
  const branch = opts.branch ?? callerWorktree.doc.branch;

  const handle = await ensureWorktree(project, PUBLISH_ACTOR, {
    branch: mainBranch,
  });

  // Compare-and-swap against the main this publish started from, so two
  // publishes racing each other fail cleanly instead of interleaving.
  const expectedMain = await defaultBranchSha(project);
  const trial = await trialMerge(handle, branch ?? mainBranch, opts.author);
  if (!trial.ok) {
    // trialMerge always says why it could not merge.
    return { ok: false, status: 409, error: trial.reason ?? "Merge failed" };
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
    return {
      ok: false,
      status: 409,
      error:
        "main moved while this publish was running — nothing shipped. Try again.",
    };
  }
  try {
    await mirrorPushNow(workspaceId);
  } catch (pushError) {
    // main advanced locally but the durable push (to the git mirror)
    // failed — bad credentials, GitHub down, a rejected ref. Roll main
    // back to where it was so the local repo and the durable store agree:
    // otherwise a serverless instance recycle would restore from the
    // (unchanged) mirror and silently "lose" this commit, and the sandbox
    // could no longer fetch it ("not our ref"). Nothing published; retry.
    await updateRefCas(
      handle.repoDir,
      `refs/heads/${mainBranch}`,
      expectedMain,
      sha,
    ).catch(() => undefined);
    return {
      ok: false,
      status: 502,
      error:
        "Could not save the change durably — the push to the git mirror failed, so nothing was published. Try again.",
      output: messageOf(pushError),
    };
  }

  if (await deploymentExists(project._id.toString(), sha)) {
    const prepared = await prepareBindings(
      project,
      sha,
      "Data binding preparation failed — the live app still serves the last successful deployment.",
    );
    if ("ok" in prepared) return prepared;
    await setPublishedSha(project, sha, { refreshing: prepared.refreshing });
    return { ok: true, sha, fileCount: 0, reused: true };
  }

  // Build main (now a durable ref) and deploy on success.
  await markDeployStage(project, sha, "build");
  await checkoutInBox(handle, sha);
  const build = await buildApp(handle, execInWorktree);
  if (!build.ok) {
    await recordDeployFailure(project, sha, "build", build.output);
    return {
      ok: false,
      status: 422,
      error:
        "Build failed — main was updated but nothing was deployed; the live app still serves the last successful build.",
      output: build.output,
    };
  }

  const prepared = await prepareBindings(
    project,
    sha,
    "Data binding preparation failed — main was updated but nothing was deployed; the live app still serves the last successful deployment.",
  );
  if ("ok" in prepared) return prepared;

  const result = await deployBuild(project, sha, handle, {
    bindingsReady: true,
    refreshing: prepared.refreshing,
  });
  return {
    ok: true,
    sha: result.sha,
    fileCount: result.fileCount,
    reused: result.reused,
  };
}

/**
 * Point the app at an earlier deployment: deployments are immutable and
 * addressed by sha, so this is a repoint after its bindings are verified.
 */
export async function rollbackApp(
  loadedProject: IAppProject,
  sha: string,
  opts: { userId?: string },
): Promise<RollbackOutcome> {
  // Same reason as publish: a folder-only app has no row, and
  // setPublishedSha's updateOne would match nothing and report success.
  const project = await ensureProjectRow(loadedProject, opts.userId ?? "");
  if (!(await deploymentExists(project._id.toString(), sha))) {
    return {
      ok: false,
      status: 404,
      error: `No stored deployment for ${sha.slice(0, 7)}`,
    };
  }
  const prepared = await prepareBindings(
    project,
    sha,
    "Rollback data preparation failed — the current live deployment was not changed.",
  );
  if ("ok" in prepared) return prepared;
  await setPublishedSha(project, sha, { refreshing: prepared.refreshing });
  return { ok: true, sha };
}

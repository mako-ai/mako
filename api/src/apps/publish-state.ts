/**
 * What is LIVE for an app, and how it relates to its default branch.
 *
 * One answer for two readers: the agent's `app_publish_status` tool and the
 * published chip in the app header. Both used to need the same facts — the
 * deployed sha, whether the branch has app changes that are not live, why
 * the last deploy did not land — and only the tool could compute them, so
 * the chip showed a bare sha with no date and no sense of staleness.
 *
 * Read from the bare repo only: no sandbox, no working copy.
 */
import type { IAppProject } from "../database/workspace-schema";
import { freshenForServe } from "./cloud-repo.service";
import { isOid, runGit } from "./git";
import {
  DEFAULT_BRANCH,
  repoDirFor,
  resolveCommit,
} from "./repository.service";
import { appRootFor } from "./worktree.service";

export interface PublishedCommit {
  author: string;
  /** Commit time in epoch ms — the history endpoint's unit. */
  timestamp: number;
  subject: string;
}

export interface PublishState {
  published: boolean;
  publishedSha: string | null;
  publishedAt: Date | null;
  /** The deployed commit, or null when it is not in the local repo. */
  publishedCommit: PublishedCommit | null;
  branch: string;
  branchSha: string | null;
  /** Last commit on the branch that touched this app's folder. */
  branchAppSha: string | null;
  upToDate: boolean;
  /**
   * Commits on the branch, after the published one, that touch this app's
   * folder — the changes a viewer of the live app does not see yet. Null
   * when unknown (not published, or the published commit is not local).
   */
  pendingCommits: number | null;
  /** Why the newest commit is not live, when it is not (cleared on success). */
  lastDeployError: IAppProject["lastDeployError"] | null;
}

export interface PublishStateInput {
  branch: string;
  appRoot: string;
  publishedSha: string | null;
  publishedAt: Date | null;
  lastDeployError: IAppProject["lastDeployError"] | null;
}

async function gitOut(repoDir: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await runGit(["-C", repoDir, ...args]);
    return stdout.trim() || null;
  } catch {
    return null;
  }
}

/** The pure git half, separated so it can be tested against a real repo. */
export async function readPublishState(
  repoDir: string,
  input: PublishStateInput,
): Promise<PublishState> {
  const { branch, appRoot, publishedAt, lastDeployError } = input;
  const branchRef = `refs/heads/${branch}`;
  // A stored sha only ever reaches argv as a full oid.
  const publishedSha =
    input.publishedSha && isOid(input.publishedSha) ? input.publishedSha : null;
  const appPath = `${appRoot}/`;

  const branchSha = await resolveCommit(repoDir, branchRef);
  // The commit that last TOUCHED this app's folder — commits to other apps
  // or non-app files must not read as "this app is stale".
  const branchAppSha = branchSha
    ? await gitOut(repoDir, [
        "log",
        "-1",
        "--pretty=%H",
        branchRef,
        "--",
        appPath,
      ])
    : null;

  // Up to date when the published deployment contains the app's last
  // change: either shas match, or the published commit is a descendant of
  // the last app-touching commit.
  let upToDate = !!publishedSha && !!branchSha && publishedSha === branchSha;
  if (!upToDate && publishedSha && branchAppSha) {
    if (publishedSha === branchAppSha) upToDate = true;
    else {
      try {
        await runGit([
          "-C",
          repoDir,
          "merge-base",
          "--is-ancestor",
          branchAppSha,
          publishedSha,
        ]);
        upToDate = true;
      } catch {
        /* not an ancestor — genuinely stale */
      }
    }
  }

  let publishedCommit: PublishedCommit | null = null;
  let pendingCommits: number | null = null;
  if (publishedSha) {
    const raw = await gitOut(repoDir, [
      "log",
      "-1",
      "--format=%an%x00%at%x00%s",
      publishedSha,
    ]);
    if (raw) {
      const [author, at, subject] = raw.split("\0");
      publishedCommit = { author, timestamp: Number(at) * 1000, subject };
    }
    if (publishedCommit && branchSha) {
      const count = upToDate
        ? "0"
        : await gitOut(repoDir, [
            "rev-list",
            "--count",
            `${publishedSha}..${branchRef}`,
            "--",
            appPath,
          ]);
      pendingCommits = count === null ? null : Number(count);
    }
  }

  return {
    published: !!publishedSha,
    publishedSha,
    publishedAt,
    publishedCommit,
    branch,
    branchSha,
    branchAppSha,
    upToDate,
    pendingCommits,
    lastDeployError,
  };
}

/**
 * Publish state for a project. `freshenIntervalMs` 0 pulls the cloud mirror
 * first (the agent asks right after a push — #894's race); the UI takes the
 * default throttle, since a hover must not cost a mirror fetch every time.
 */
export async function publishState(
  project: IAppProject,
  freshenIntervalMs?: number,
): Promise<PublishState> {
  const workspaceId = project.workspaceId.toString();
  await freshenForServe(workspaceId, freshenIntervalMs);
  return readPublishState(repoDirFor(workspaceId), {
    branch: project.defaultBranch || DEFAULT_BRANCH,
    appRoot: appRootFor(project),
    publishedSha: project.publishedSha ?? null,
    publishedAt: project.publishedAt ?? null,
    lastDeployError: project.lastDeployError ?? null,
  });
}

/**
 * Test-only harness for writes that must land on the mirror's main: a
 * file:// "GitHub" remote, this instance's bare cache cloned from it, and a
 * hook that moves the remote's main right after a freshen — the moment
 * another instance (or a merged PR) wins the race in production.
 *
 * The hook needs the fetch module mocked in the test file:
 *
 *   vi.mock("<path>/apps/cloud-repo/fetch", async importOriginal => {
 *     const { withFreshenHook } = await import("<path>/durable-main.testkit");
 *     return withFreshenHook(await importOriginal());
 *   });
 *
 * and the env the remote base needs: APPS_GITHUB_REMOTE_BASE set to
 * `file://<root>/remotes`, APPS_CONNECTED_REPO_PUSH=allow.
 */
import fs from "node:fs/promises";
import path from "node:path";
import { runGit } from "../git";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  initRepo,
  repoDirFor,
  type BlobMutation,
} from "../repository.service";
import { bindTestWorkspaceRepo } from "../bind-test-workspace-repo";

export const freshenHooks = {
  /** Freshens of main so far (1-based once one ran). */
  calls: 0,
  /** Run once, right after the n-th freshen of main. */
  after: new Map<number, () => Promise<void>>(),
};

export function resetFreshenHooks(): void {
  freshenHooks.calls = 0;
  freshenHooks.after.clear();
}

/** The fetch module with `freshenBeforeMainWrite` calling the hooks. */
export function withFreshenHook<
  T extends { freshenBeforeMainWrite: (workspaceId: string) => Promise<void> },
>(actual: T): T {
  return {
    ...actual,
    freshenBeforeMainWrite: async (workspaceId: string) => {
      await actual.freshenBeforeMainWrite(workspaceId);
      freshenHooks.calls += 1;
      const hook = freshenHooks.after.get(freshenHooks.calls);
      if (hook) {
        freshenHooks.after.delete(freshenHooks.calls);
        await hook();
      }
    },
  };
}

/**
 * A fresh remote holding `files` on main, this instance's bare cache cloned
 * from it, and the workspace bound to it. Returns the remote's directory.
 */
export async function seedMirroredWorkspace(
  remotesRoot: string,
  workspaceId: string,
  files: Record<string, string>,
): Promise<string> {
  // bindTestWorkspaceRepo binds test-owner/test-repo: that is the remote.
  const remoteDir = path.join(remotesRoot, "test-owner", "test-repo.git");
  await fs.rm(remoteDir, { recursive: true, force: true });
  await fs.rm(repoDirFor(workspaceId), { recursive: true, force: true });
  await initRepo(remoteDir, files);
  await fs.mkdir(path.dirname(repoDirFor(workspaceId)), { recursive: true });
  await runGit([
    "clone",
    "--bare",
    "--quiet",
    remoteDir,
    repoDirFor(workspaceId),
  ]);
  await bindTestWorkspaceRepo(workspaceId);
  return remoteDir;
}

/** Another instance (or a merged PR) commits straight onto GitHub's main. */
export async function commitOnRemoteMain(
  remoteDir: string,
  mutation: BlobMutation,
  message = "another instance",
): Promise<string> {
  const result = await commitBlobsOnBranch(
    remoteDir,
    DEFAULT_BRANCH,
    mutation,
    { message },
  );
  return result.commitOid;
}

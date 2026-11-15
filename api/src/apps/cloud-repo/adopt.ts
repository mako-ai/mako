/**
 * Adopting a newly connected repo (import, seed or refuse), proving the
 * local tree matches the mirror's main, and creating a workspace repo.
 */
import { resolveRepoToken } from "../../integrations/github/app-auth";
import fs from "node:fs/promises";
import { runGit } from "../git";
import {
  DEFAULT_BRANCH,
  initRepo,
  repoDirFor,
  repoExists,
  resolveCommit,
  type GitAuthor,
} from "../repository.service";
import { initialWorkspaceFiles } from "../workspace-template";
import { loggers } from "../../logging";
import {
  remoteUrl,
  connectedTierEnabled,
  resolveMirrorTarget,
  tokenFor,
  authArgs,
  cloneMirrorInto,
  ensureLocalRepo,
} from "./target";
import { mirrorPushNow } from "./push";
import { fetchFromCloud } from "./fetch";

const logger = loggers.api("apps");

/**
 * Thrown when we cannot PROVE the local tree matches the mirror's main.
 *
 * Distinct from a freshen failure, which is survivable: this one means a
 * caller must not proceed with something destructive.
 */
export class TreeNotVerifiedError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "TreeNotVerifiedError";
  }
}

/**
 * Fail CLOSED: prove the tree a caller read is the mirror's current main, or
 * throw.
 *
 * `freshenBeforeMainWrite` is deliberately best-effort — a brief mirror outage
 * must not fail a user's save, so it logs and proceeds. That trade is right
 * for a commit and wrong for a deletion, and the asymmetry is not a matter of
 * degree. A dbt job row deleted from a stale read comes back on the next sync,
 * because the file recreates it. A CDC teardown DISPOSES CHECKPOINTS
 * (`CdcEntityState.lastIngestSeq`, `backfillCursor`): recreating the flow does
 * not recover the stream position, it re-backfills from scratch. One is churn;
 * the other is data loss.
 *
 * So the destructive path asks a different question — not "did we try to
 * refresh?" but "is this tree definitely current?" — and refuses when the
 * answer is unknown. `ls-remote` is asked rather than the local repo, because
 * the local repo is the very thing under suspicion.
 *
 * The consequence is deliberate and worth stating where it will be found: when
 * the mirror is unreachable, a genuinely deleted flow does NOT tear down on
 * this push. It tears down on the next one. Someone will eventually report
 * that as a bug; it is the cost of never tearing down a live stream because we
 * could not check.
 *
 * A workspace with no mirror (dev, previews — the connected tier gated off)
 * has nothing to diverge from: the local repo IS the store, so the check
 * passes.
 */
export async function assertTreeAtMirrorMain(
  workspaceId: string,
  treeSha: string,
): Promise<void> {
  const target = await resolveMirrorTarget(workspaceId);
  if (!target) return; // No mirror: the local repo is authoritative.
  if (!/^[0-9a-f]{40}$/.test(treeSha)) {
    throw new TreeNotVerifiedError(
      `Refusing a destructive reconcile: "${treeSha}" is not a commit sha`,
    );
  }
  const url = remoteUrl(target.owner, target.repo);
  const token = await tokenFor(target);
  let remoteMain: string;
  try {
    const { stdout } = await runGit([
      ...authArgs(token),
      "ls-remote",
      url,
      `refs/heads/${DEFAULT_BRANCH}`,
    ]);
    remoteMain = stdout.trim().split(/\s+/)[0] ?? "";
  } catch (error) {
    throw new TreeNotVerifiedError(
      `Refusing a destructive reconcile: could not read the mirror's ${DEFAULT_BRANCH} (${
        error instanceof Error ? error.message : String(error)
      })`,
    );
  }
  if (!/^[0-9a-f]{40}$/.test(remoteMain)) {
    throw new TreeNotVerifiedError(
      `Refusing a destructive reconcile: the mirror reported no ${DEFAULT_BRANCH}`,
    );
  }
  if (remoteMain !== treeSha) {
    throw new TreeNotVerifiedError(
      `Refusing a destructive reconcile: read at ${treeSha.slice(0, 8)} but the mirror's ${DEFAULT_BRANCH} is ${remoteMain.slice(0, 8)}`,
    );
  }
}

/**
 * Whether the remote's default branch and the local one descend from a common
 * commit. Fetching the remote tip into the local object store is harmless (a
 * fetch never moves a local ref) and is what the reconcile step needs anyway.
 * A remote with content but no default branch, or an unreachable remote,
 * answers "no": the caller then refuses, which is the safe side.
 */
async function sharesHistoryWith(
  repoDir: string,
  url: string,
  token: string | undefined,
): Promise<boolean> {
  try {
    await runGit([
      "-C",
      repoDir,
      ...authArgs(token),
      "fetch",
      "--quiet",
      url,
      `refs/heads/${DEFAULT_BRANCH}`,
    ]);
    await runGit([
      "-C",
      repoDir,
      "merge-base",
      "FETCH_HEAD",
      `refs/heads/${DEFAULT_BRANCH}`,
    ]);
    return true;
  } catch {
    return false;
  }
}

export type ConnectedRepoAdoption =
  "imported" | "seeded" | "reconnected" | "fresh" | "deferred";

/**
 * Connect-time reconciliation between the workspace's existing history and
 * the newly linked repo (§13.17). At most one side may have content:
 *
 *  - repo has content, workspace has none → IMPORT: the repo's history
 *    becomes the workspace repo, and its `apps/<slug>/mako.json` folders
 *    appear as apps with no registration step (§13 doctrine, now applied to
 *    customer repos).
 *  - workspace has content, repo is empty → SEED: the workspace history is
 *    pushed into the repo; it is the mirror from here on.
 *  - both empty → nothing to reconcile; the first commit seeds the repo.
 *  - both have content and share history → RECONNECT: this is the
 *    disconnect-then-connect-again case (the repo WAS this workspace's
 *    mirror; unlinking never touches the local repo, so both sides hold the
 *    same commits). The two tips are reconciled the way every later fetch
 *    reconciles them (`fetchFromCloud`: remote ahead → fast-forward, local
 *    ahead → push, diverged → the mirror wins with the local tip parked
 *    under refs/mako/diverged/*, nothing dropped), then pushed.
 *  - both have content and NO common ancestor → refuse. Choosing whose
 *    history wins is not ours to guess; the caller rolls the binding back.
 *
 * Where the connected tier is gated off (previews/dev on prod-cloned DBs) the
 * binding is stored as inert metadata: "deferred".
 */
export async function adoptConnectedRepo(
  workspaceId: string,
  binding: { owner: string; repo: string; installationId?: number },
): Promise<ConnectedRepoAdoption> {
  if (!connectedTierEnabled()) return "deferred";
  const token = await resolveRepoToken(binding.installationId);
  const url = remoteUrl(binding.owner, binding.repo);
  const label = `${binding.owner}/${binding.repo}`;

  const repoDir = repoDirFor(workspaceId);
  const hasHistory =
    (await repoExists(repoDir)) &&
    (await runGit([
      "-C",
      repoDir,
      "rev-parse",
      "--verify",
      `refs/heads/${DEFAULT_BRANCH}`,
    ])
      .then(() => true)
      .catch(() => false));

  const lsRemote = await runGit([...authArgs(token), "ls-remote", url]);
  const remoteEmpty = lsRemote.stdout.trim() === "";

  if (!remoteEmpty && hasHistory) {
    if (!(await sharesHistoryWith(repoDir, url, token))) {
      throw new Error(
        `${label} already has content unrelated to this workspace's history, and this workspace already has apps. ` +
          "Reconnect the repository this workspace was previously connected to, " +
          "connect an empty repository (the workspace's history will be pushed into it), " +
          "or import a non-empty repository into a workspace that has no apps yet.",
      );
    }
    // RECONNECT: same lineage on both sides. Reconcile main exactly as a
    // webhook fetch would, then push so the mirror carries whatever the
    // local side has that it lacks (local-ahead commits, refs/mako/*, a
    // parked diverged tip).
    await fetchFromCloud(workspaceId, DEFAULT_BRANCH);
    await mirrorPushNow(workspaceId);
    logger.info("Apps workspace reconnected to a repo sharing its history", {
      workspaceId,
      repo: label,
    });
    return "reconnected";
  }
  if (!remoteEmpty) {
    // IMPORT: drop the (history-less) local slot and adopt the repo's history.
    await fs.rm(repoDir, { recursive: true, force: true });
    await cloneMirrorInto(workspaceId, url, token, label);
    logger.info("Apps workspace imported its connected repo", {
      workspaceId,
      repo: label,
    });
    return "imported";
  }
  if (hasHistory) {
    await mirrorPushNow(workspaceId);
    logger.info("Apps workspace history seeded into its connected repo", {
      workspaceId,
      repo: label,
    });
    return "seeded";
  }
  return "fresh";
}

/**
 * The workspace repo, restored from its mirror or initialized with the
 * starter template. Repos are provisioned lazily by whichever content type
 * arrives first — app creation, console saves and skill writes all converge
 * here (§10 monorepo).
 */
export async function ensureWorkspaceRepo(
  workspaceId: string,
  author?: GitAuthor,
): Promise<string> {
  await ensureLocalRepo(workspaceId);
  const repoDir = repoDirFor(workspaceId);
  const hasMain =
    (await repoExists(repoDir)) &&
    Boolean(await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`));
  if (!hasMain) {
    // `git clone --mirror` of an empty GitHub repo still creates a bare
    // directory with no refs. The first write needs `main` so it can seed
    // the mirror (issue #956).
    if (await repoExists(repoDir)) {
      await fs.rm(repoDir, { recursive: true, force: true });
    }
    await initRepo(repoDir, initialWorkspaceFiles(workspaceId), {
      message: "Initialize workspace repository",
      author,
    });
  }
  return repoDir;
}

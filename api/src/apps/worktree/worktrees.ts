/**
 * Opening a worktree handle: the actor's worktree doc and sandbox for an app
 * (or the whole workspace repo).
 */
import {
  type IAppProject,
  type IAppWorktree,
} from "../../database/workspace-schema";
import { loggers } from "../../logging";
import {
  appsMetadataRepo,
  toAppWorktreeCompat,
} from "../../repositories/apps-metadata";
import { boxHasRepo, boxHead } from "../box";
import { ZERO_OID } from "../git";
import {
  DEFAULT_BRANCH,
  repoExists,
  resolveCommit,
  updateRefCas,
} from "../repository.service";

import { getSandboxProvider } from "../sandbox/provider";
import { repoForWorkspace, appRootFor, WorktreeHandle } from "./repo";
import { boxCtx } from "./box-session";
import { defaultBranchForActor } from "../branch-policy";
import { isPersonActorId } from "../actor-id";

const logger = loggers.api("apps");

// ---------------------------------------------------------------------------
// Worktree + session materialization
// ---------------------------------------------------------------------------

/**
 * Dedicated actor for publishing (§13.3).
 *
 * Publishing must build from `main` and nothing else, so it gets its own
 * worktree instead of borrowing whoever happened to trigger it. Two reasons:
 * a human's session sits on their own branch with uncommitted WIP, and
 * `ensureWorktree` only fast-forwards a CLEAN worktree — so a session with WIP
 * would build a stale tree that can predate the app being published. Keeping
 * this worktree write-free means it fast-forwards to the branch head every
 * time.
 */
export const PUBLISH_ACTOR = "publish";

/**
 * A 24-hex (Mongo ObjectId-shaped) actor id.
 *
 * NOT "is this a person": real Mako user ids are 15 characters
 * (auth.service.ts generateId, hex today, base36 for older accounts), so this
 * answers false for nearly every real user. Kept with its old meaning for its
 * one remaining caller, ensureProjectRow (project-rows.ts): the claim of an
 * existing ownerless row, always, and the owner of a new row while
 * APPS_ROW_OWNER_PERSON_IDS is off. Widening the claim would hand every
 * ownerless app row to whoever touches it next. Use isPersonActorId for "is
 * this a person".
 */
export function isUserActor(actorId: string): boolean {
  return /^[0-9a-f]{24}$/i.test(actorId);
}

export { isPersonActorId };

/** The opposite of isPersonActorId: publish, api-key and other sentinels. */
export function isSystemActor(actorId: string): boolean {
  return !isPersonActorId(actorId);
}

/**
 * Find-or-create the record of which branch this actor works on.
 *
 * `actorId` is a user id for UI/API actors. Everyone gets their own branch —
 * you do not edit production — created off the default branch head the first
 * time they touch the workspace.
 *
 * No sandbox is started here, and no working copy is materialized. This is a
 * question about branches, and it has to keep answering while the sandbox is
 * asleep, because the file tree depends on it.
 */
export async function ensureWorktree(
  project: IAppProject,
  actorId: string,
  options: { branch?: string } = {},
): Promise<WorktreeHandle> {
  const core = await ensureWorktreeCore(
    project.workspaceId.toString(),
    actorId,
    options,
  );
  return { ...core, project, appRoot: appRootFor(project) };
}

/**
 * The workspace-scoped handle: same session doc, same sandbox, no app lens.
 * This is what repo-level surfaces (Source Control, workspace repo routes)
 * use — the worktree was always keyed by (workspace, actor); only the code
 * used to insist on an app to reach it.
 */
export async function ensureWorkspaceWorktree(
  workspaceId: string,
  actorId: string,
  options: { branch?: string } = {},
): Promise<WorktreeHandle> {
  const core = await ensureWorktreeCore(workspaceId, actorId, options);
  return { ...core, appRoot: "" };
}

async function ensureWorktreeCore(
  workspaceId: string,
  actorId: string,
  options: { branch?: string } = {},
): Promise<{ doc: IAppWorktree; repoDir: string }> {
  const repoDir = await repoForWorkspace(workspaceId);
  if (!(await repoExists(repoDir))) {
    throw new Error("Workspace repository is missing");
  }

  const mainHead = await resolveCommit(repoDir, `refs/heads/${DEFAULT_BRANCH}`);
  if (!mainHead) throw new Error("Workspace default branch is missing");

  // The doc remembers which branch this actor is on (checkoutBranch writes
  // it); an actor with no doc yet starts on the default branch, like a fresh
  // clone. options.branch overrides both (publish pins main explicitly).
  const existing = await appsMetadataRepo.findWorktree(workspaceId, actorId);
  const branch =
    options.branch ?? existing?.branch ?? defaultBranchForActor(actorId);
  let branchHead = await resolveCommit(repoDir, `refs/heads/${branch}`);
  if (!branchHead) {
    // The remembered branch no longer exists (deleted from another checkout,
    // say) — fork it back off the default branch head rather than failing.
    // CAS-create; a concurrent creator winning is fine (re-resolve).
    await updateRefCas(repoDir, `refs/heads/${branch}`, mainHead, ZERO_OID);
    branchHead = await resolveCommit(repoDir, `refs/heads/${branch}`);
    if (!branchHead) throw new Error(`Failed to create branch ${branch}`);
    logger.info("Apps actor branch created", { workspaceId, branch });
  }

  // No automatic merging of main into the actor's branch. That existed for
  // the forced-personal-branch era, when everyone lived forever on a branch
  // that would otherwise never learn about new apps. Branches are explicit
  // now — you make one when you want one — and no laptop merges main into
  // your feature branch behind your back. `git merge main` (terminal) or
  // switching to main (UI) is the git-native way to catch up.

  // Atomic find-or-create: the agent routinely fires tool calls in parallel
  // right after app creation, so a findOne+create pair races itself into
  // duplicate-key errors on the (workspaceId, actor) unique index.
  const worktreeRec = await appsMetadataRepo.ensureWorktreeRow(
    workspaceId,
    actorId,
    branch,
  );
  const doc = toAppWorktreeCompat(worktreeRec, async d => {
    await appsMetadataRepo.updateWorktreeBranch(
      d.workspaceId.toString(),
      d.userId,
      d.branch,
    );
  });

  return { doc, repoDir };
}

/**
 * Follow a branch switch made in the terminal.
 *
 * `git checkout` in the shell is a legitimate way to change branches — it is
 * the same command the button runs — so the cached branch follows the sandbox
 * rather than the other way round. Cheap, and never fatal: a stale cache
 * shows the wrong branch name for a moment; refusing to read would show
 * nothing at all.
 */
export async function syncBranchFromBox(handle: WorktreeHandle): Promise<void> {
  try {
    const ctx = boxCtx(handle);
    if (!(await getSandboxProvider().hasSession(ctx))) return;
    if (!(await boxHasRepo(ctx))) return;
    const { branch } = await boxHead(ctx);
    if (branch && branch !== "HEAD" && branch !== handle.doc.branch) {
      logger.info("Apps following a branch switch made in the sandbox", {
        from: handle.doc.branch,
        to: branch,
      });
      handle.doc.branch = branch;
      await appsMetadataRepo.updateWorktreeBranch(
        handle.doc.workspaceId.toString(),
        handle.doc.userId,
        branch,
      );
    }
  } catch {
    // Not worth failing a read over.
  }
}

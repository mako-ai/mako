/**
 * Branch policy — the one place that answers "which branch does this commit
 * land on?" for content written through Mako.
 *
 * The doctrine this module encodes (apps.md §18) is three separate rules that
 * used to travel under one slogan ("every save is a commit"):
 *
 * 1. DURABILITY — an ephemeral working copy (the sandbox, a Monaco buffer)
 *    never holds work the server is responsible for: agent turns and manual
 *    saves commit AND push. A laptop clone is exempt — uncommitted work there
 *    is the owner's, exactly as on any machine. This rule is not negotiable
 *    and is enforced where the writes happen (worktree.service, the per-kind
 *    commit services), not here.
 *
 * 2. REF POLICY (this module) — which branch those commits advance. It is
 *    per-actor session state (`AppWorktree.branch`, the same pointer a
 *    `git checkout` in the terminal moves), defaulting per content kind:
 *    - Apps and (later) dbt follow the actor's session branch. Main is not
 *      production for apps — publish deploys a PINNED sha — so main is an
 *      acceptable default; anyone can work on a branch by switching in the
 *      Source Control panel or the terminal, and protection belongs to the
 *      remote (the git endpoint's pre-receive hook), not to a forced-branch
 *      ceremony.
 *    - Consoles and skills commit to the DEFAULT branch regardless of the
 *      actor's session branch, because their Mongo rows are a derived index
 *      of main: a save committed to a feature branch would be visually
 *      reverted by the next index sync. Branch-scoped indexes are the
 *      prerequisite for lifting this (apps.md §18), not a policy toggle.
 *
 * 3. GRANULARITY — whether a save amends, squashes, or stands alone is a
 *    per-surface choice (see autoCommitFileEdit's history in
 *    worktree.service); it is deliberately NOT policy here.
 */
import { Types } from "mongoose";
import { AppWorktree } from "../database/workspace-schema";
import { DEFAULT_BRANCH } from "./repository.service";

/** Content kinds that commit through Mako (dbt joins with Block D3). */
export type RepoContentKind = "app" | "console" | "skill" | "dbt";

/**
 * Which branch an actor starts on when the caller does not name one: the
 * default branch, like a fresh clone on a laptop.
 *
 * Actors used to be forced onto a personal `user/<id>` branch ("you do not
 * edit production"). That guarded the wrong thing: publish deploys a PINNED
 * sha, so a commit on `main` moves the branch but ships nothing — exactly
 * like committing to main of a repo whose releases are tagged. Meanwhile the
 * forced branch made the everyday experience alien: everyone lived on a
 * branch named after their user id, and "just commit it" needed a merge
 * ceremony. Now the working copy is unrestricted, git-native; whoever wants
 * main protected does it at the remote (the git endpoint's pre-receive hook
 * carries GitHub's defaults — no force-push, no delete — and a mirrored
 * GitHub repo can layer its own rules).
 */
export function defaultBranchForActor(_actorId: string): string {
  return DEFAULT_BRANCH;
}

/**
 * The branch this actor's session is on — the same pointer `git checkout`
 * moves and the Source Control panel displays. An actor with no session yet
 * is on the default branch, like a fresh clone.
 */
export async function sessionBranchFor(
  workspaceId: string,
  actorId: string,
): Promise<string> {
  const doc = await AppWorktree.findOne({
    workspaceId: new Types.ObjectId(workspaceId),
    userId: actorId,
  });
  return doc?.branch || defaultBranchForActor(actorId);
}

/**
 * Where a commit of this content kind lands (rule 2 above). Indexed kinds
 * pin to the default branch until their indexes are branch-scoped.
 */
export async function commitBranchFor(
  kind: RepoContentKind,
  workspaceId: string,
  actorId: string,
): Promise<string> {
  switch (kind) {
    case "console":
    case "skill":
      return DEFAULT_BRANCH;
    case "app":
    case "dbt":
      return sessionBranchFor(workspaceId, actorId);
  }
}

/**
 * The workspace custom prompt is a repo file: `PROMPT.md` (apps.md §21).
 *
 * It was a markdown blob in `workspace.settings.customPrompt` — edited in a
 * settings textarea with no history, no review, no diff. As a file at the
 * workspace repo root it gets git history and the Source Control diff
 * surface, agents (and laptop clones) can read and propose changes to it,
 * and it composes with the other repo-resident instructions (.makorules,
 * skills/). Reads fall back to the legacy Mongo field so a workspace
 * without a repo keeps its existing prompt; edits require the repo (§17).
 *
 * Ref policy: PROMPT.md commits to the DEFAULT branch — it is workspace
 * config every agent turn reads, not per-session content (branch-policy.ts
 * rule 2, same rationale as consoles/skills).
 */
import { RepoRequiredError, appsRequireConnectedRepo } from "./config";
import { authorForUser } from "./workspace-consoles.service";
import {
  ensureWorkspaceRepo,
  freshenBeforeMainWrite,
  queueMirrorPush,
  resolveMirrorTarget,
} from "./cloud-repo.service";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  readBlob,
  repoDirFor,
  repoExists,
} from "./repository.service";

export const PROMPT_PATH = "PROMPT.md";

/** The committed prompt, or null when the repo or file does not exist. */
export async function readWorkspacePromptFile(
  workspaceId: string,
): Promise<string | null> {
  const repoDir = repoDirFor(workspaceId);
  if (!(await repoExists(repoDir))) return null;
  try {
    const blob = await readBlob(
      repoDir,
      `refs/heads/${DEFAULT_BRANCH}`,
      PROMPT_PATH,
    );
    return blob.isBinary ? null : blob.contents;
  } catch {
    return null;
  }
}

/**
 * Commit the prompt (empty/whitespace content deletes the file). The one
 * write path for the settings UI, the reset action, and adoption.
 */
export async function commitWorkspacePrompt(
  workspaceId: string,
  content: string,
  actorUserId?: string,
): Promise<{ commitOid?: string; unchanged: boolean }> {
  // Production: the workspace's own repo is the only durable store (§17).
  if (appsRequireConnectedRepo() && !(await resolveMirrorTarget(workspaceId))) {
    throw new RepoRequiredError();
  }
  const repoDir = await ensureWorkspaceRepo(workspaceId);
  if (!(await repoExists(repoDir))) throw new RepoRequiredError();
  // Commit onto the mirror's main, not a stale cached tip.
  await freshenBeforeMainWrite(workspaceId);
  const author = actorUserId ? await authorForUser(actorUserId) : undefined;
  const trimmed = content.trim();
  const result = await commitBlobsOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    trimmed
      ? {
          writes: {
            [PROMPT_PATH]: content.endsWith("\n") ? content : `${content}\n`,
          },
        }
      : { deletes: [PROMPT_PATH] },
    {
      message: trimmed
        ? `prompt: update ${PROMPT_PATH}`
        : `prompt: clear ${PROMPT_PATH}`,
      author,
    },
  );
  if (!result.unchanged) queueMirrorPush(workspaceId);
  return {
    commitOid: result.unchanged ? undefined : result.commitOid,
    unchanged: result.unchanged,
  };
}

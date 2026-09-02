/**
 * Workspace instruction files: `PROMPT.md` and `SELF_DIRECTIVE.md` (apps.md §21).
 *
 * Git is the only store. There is no Mongo fallback: a missing file is an
 * empty / default prompt, never a stale `settings.customPrompt` blob.
 *
 * Ref policy: both files commit to the DEFAULT branch — workspace config
 * every agent turn reads, not per-session content (branch-policy.ts rule 2).
 */
import { authorForUser } from "./workspace-consoles.service";
import {
  boundRepoDirIfExists,
  requireWorkspaceRepo,
} from "./workspace-repo-required";
import { freshenBeforeMainWrite, queueMirrorPush } from "./cloud-repo.service";
import {
  DEFAULT_BRANCH,
  commitBlobsOnBranch,
  readBlob,
} from "./repository.service";

export const PROMPT_PATH = "PROMPT.md";
export const SELF_DIRECTIVE_PATH = "SELF_DIRECTIVE.md";

async function readRepoTextFile(
  workspaceId: string,
  relPath: string,
): Promise<string | null> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return null;
  try {
    const blob = await readBlob(
      repoDir,
      `refs/heads/${DEFAULT_BRANCH}`,
      relPath,
    );
    return blob.isBinary ? null : blob.contents;
  } catch {
    return null;
  }
}

/** The committed prompt, or null when the repo or file does not exist. */
export async function readWorkspacePromptFile(
  workspaceId: string,
): Promise<string | null> {
  return readRepoTextFile(workspaceId, PROMPT_PATH);
}

/** The committed self-directive, or null when the repo or file does not exist. */
export async function readWorkspaceSelfDirectiveFile(
  workspaceId: string,
): Promise<string | null> {
  return readRepoTextFile(workspaceId, SELF_DIRECTIVE_PATH);
}

async function commitWorkspaceTextFile(
  workspaceId: string,
  relPath: string,
  content: string,
  actorUserId: string | undefined,
  messages: { update: string; clear: string },
): Promise<{ commitOid?: string; unchanged: boolean }> {
  const repoDir = await requireWorkspaceRepo(workspaceId);
  await freshenBeforeMainWrite(workspaceId);
  const author = actorUserId ? await authorForUser(actorUserId) : undefined;
  const trimmed = content.trim();
  const result = await commitBlobsOnBranch(
    repoDir,
    DEFAULT_BRANCH,
    trimmed
      ? {
          writes: {
            [relPath]: content.endsWith("\n") ? content : `${content}\n`,
          },
        }
      : { deletes: [relPath] },
    {
      message: trimmed ? messages.update : messages.clear,
      author,
    },
  );
  if (!result.unchanged) queueMirrorPush(workspaceId);
  return {
    commitOid: result.unchanged ? undefined : result.commitOid,
    unchanged: result.unchanged,
  };
}

/**
 * Commit the prompt (empty/whitespace content deletes the file).
 */
export async function commitWorkspacePrompt(
  workspaceId: string,
  content: string,
  actorUserId?: string,
): Promise<{ commitOid?: string; unchanged: boolean }> {
  return commitWorkspaceTextFile(
    workspaceId,
    PROMPT_PATH,
    content,
    actorUserId,
    {
      update: `prompt: update ${PROMPT_PATH}`,
      clear: `prompt: clear ${PROMPT_PATH}`,
    },
  );
}

/** Commit the self-directive (empty/whitespace content deletes the file). */
export async function commitWorkspaceSelfDirective(
  workspaceId: string,
  content: string,
  actorUserId?: string,
): Promise<{ commitOid?: string; unchanged: boolean }> {
  return commitWorkspaceTextFile(
    workspaceId,
    SELF_DIRECTIVE_PATH,
    content,
    actorUserId,
    {
      update: `self-directive: update ${SELF_DIRECTIVE_PATH}`,
      clear: `self-directive: clear ${SELF_DIRECTIVE_PATH}`,
    },
  );
}

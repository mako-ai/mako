/**
 * Make a hidden skill visible where it was pushed: a GitHub commit status on
 * main's head, context `mako/skills`.
 *
 * A `skills/<name>/SKILL.md` over a limit, or with front matter that does not
 * parse, drops out of the agent's index. Nothing said so: one workspace had 4
 * of 143 skills hidden, one of them for 10 weeks over a single unquoted YAML
 * item. The commit on GitHub is what the person who pushed is looking at, so
 * that is where the red cross belongs.
 *
 * States follow the app deploy status (deploy-commit-status.ts), which marks
 * a commit `failure` when what it ships does not go live, and `success` with
 * a line of text for anything benign:
 *
 *  - an invalid skill file → `failure`, naming the file and the reason;
 *  - warnings only (a description cut by the index, a refused resource) →
 *    `success`, with the warning in the description. GitHub commit statuses
 *    have no neutral state;
 *  - every file loads → `success`.
 *
 * A workspace with no skill files gets no status. Best effort: a missing
 * permission, a network error or an unbound repo is logged and swallowed.
 */
import { postCommitStatus } from "../integrations/github/github-api";
import { resolveRepoToken } from "../integrations/github/app-auth";
import { loggers } from "../logging";
import { mirrorPushNow, resolveMirrorTarget } from "./cloud-repo.service";
import {
  loadSkillCatalog,
  type SkillCatalog,
} from "./workspace-skills.service";

const logger = loggers.api("skills-status");

export const SKILLS_STATUS_CONTEXT = "mako/skills";

/** GitHub caps a status description at 140 characters. */
const DESCRIPTION_MAX_CHARS = 140;

function clip(text: string, max = DESCRIPTION_MAX_CHARS): string {
  const oneLine = text.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? `${oneLine.slice(0, max - 1)}…` : oneLine;
}

function plural(count: number, word: string): string {
  return `${count} ${word}${count === 1 ? "" : "s"}`;
}

/** The first problem in full, the rest as a count: 140 characters fit one. */
function firstAndMore(items: Array<{ path: string; reason: string }>): string {
  const [first, ...rest] = items;
  return `${first.path}: ${first.reason}${rest.length > 0 ? ` (+${rest.length} more)` : ""}`;
}

/**
 * The status a catalog earns, or null when the workspace has no skill files.
 * Pure, so the wording is unit-tested.
 */
export function describeSkillsStatus(
  catalog: Pick<SkillCatalog, "skills" | "invalid" | "warnings">,
): { state: "success" | "failure"; description: string } | null {
  const { skills, invalid, warnings } = catalog;
  if (skills.length === 0 && invalid.length === 0) return null;
  if (invalid.length > 0) {
    return {
      state: "failure",
      description: clip(
        `${plural(invalid.length, "skill file")} hidden from the agent: ${firstAndMore(invalid)}`,
      ),
    };
  }
  if (warnings.length > 0) {
    return {
      state: "success",
      description: clip(
        `${plural(skills.length, "skill")} load, ${plural(warnings.length, "warning")}: ${firstAndMore(warnings)}`,
      ),
    };
  }
  return {
    state: "success",
    description: `${plural(skills.length, "skill")} load`,
  };
}

/** The GitHub App lacks "Commit statuses: write" (as deploy-commit-status.ts). */
function isPermissionError(message: string): boolean {
  return (
    /GitHub 40[34]\b/.test(message) ||
    /Resource not accessible by integration/i.test(message)
  );
}

/** Where the status links to: Settings → Skills, which lists every reason. */
function skillsTargetUrl(): string | undefined {
  const base = (process.env.CLIENT_URL || process.env.PUBLIC_URL || "").replace(
    /\/+$/,
    "",
  );
  return base ? `${base}/settings/skills` : undefined;
}

// A push through Mako's git endpoint reaches GitHub, whose webhook then runs
// the same reconcile: remember the last head reported per workspace so one
// push posts once. Bounded like the skill catalog cache.
const MAX_REMEMBERED_HEADS = 256;
const reportedHeads = new Map<string, string>();
const warnedWorkspaces = new Set<string>();

function rememberHead(workspaceId: string, head: string): void {
  reportedHeads.delete(workspaceId);
  reportedHeads.set(workspaceId, head);
  while (reportedHeads.size > MAX_REMEMBERED_HEADS) {
    const oldest = reportedHeads.keys().next().value as string | undefined;
    if (!oldest) break;
    reportedHeads.delete(oldest);
  }
}

/**
 * Post the skills status for main's head. Called after every push to main
 * (worktree.service `syncRepoBackedResources`). Never throws.
 */
export async function reportSkillsCommitStatus(
  workspaceId: string,
): Promise<{ posted: boolean; reason?: string }> {
  let head: string | null = null;
  try {
    const catalog = await loadSkillCatalog(workspaceId);
    head = catalog.head;
    if (!head) return { posted: false, reason: "no-repo" };
    // A file git could not read just now is not a hidden skill: say nothing
    // and let the next push, or the next read, try again.
    if (catalog.incomplete) return { posted: false, reason: "incomplete" };
    const status = describeSkillsStatus(catalog);
    if (!status) return { posted: false, reason: "no-skills" };
    if (catalog.invalid.length > 0 || catalog.warnings.length > 0) {
      // The status line holds one problem; the log holds all of them.
      logger.warn("Workspace skill files need attention", {
        workspaceId,
        sha: head,
        invalid: catalog.invalid.map(file => `${file.path}: ${file.reason}`),
        warnings: catalog.warnings.map(file => `${file.path}: ${file.reason}`),
      });
    }
    if (reportedHeads.get(workspaceId) === head) {
      return { posted: false, reason: "already-reported" };
    }
    // Same gate as every other write to the customer repo: production (or
    // the explicit opt-in). A preview or a laptop never marks real commits.
    const target = await resolveMirrorTarget(workspaceId);
    if (!target) return { posted: false, reason: "no-connected-repo" };
    const token = await resolveRepoToken(target.installationId);
    if (!token) return { posted: false, reason: "no-token" };
    // A commit made through Mako is mirrored in the background. GitHub
    // refuses a status on a sha it does not have, so wait for the mirror.
    await mirrorPushNow(workspaceId);
    await postCommitStatus(
      target.owner,
      target.repo,
      head,
      {
        state: status.state,
        description: status.description,
        context: SKILLS_STATUS_CONTEXT,
        targetUrl: skillsTargetUrl(),
      },
      token,
    );
    rememberHead(workspaceId, head);
    return { posted: true };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const permission = isPermissionError(message);
    if (!permission || !warnedWorkspaces.has(workspaceId)) {
      if (permission) warnedWorkspaces.add(workspaceId);
      logger.warn("Could not post the skills commit status", {
        workspaceId,
        sha: head,
        error: message,
        ...(permission
          ? {
              hint: 'Grant the GitHub App "Commit statuses: Read and write" and accept it on the installation',
            }
          : {}),
      });
    }
    return { posted: false, reason: permission ? "permission" : "error" };
  }
}

/** Test seam: forget what was reported and who was warned. */
export function resetSkillsStatusForTest(): void {
  reportedHeads.clear();
  warnedWorkspaces.clear();
}

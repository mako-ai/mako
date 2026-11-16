/**
 * Read-only access to the whole workspace repo: repo_glob, repo_grep and
 * repo_read_file.
 *
 * The app_* and workflow_* file tools see one app or one workflow folder.
 * A business question often needs the rest: the dbt models and their YAML,
 * the ontology registry, the skills, the flows, another app's bindings.
 * These three read any of it, in every mode and over MCP, and never write.
 *
 * They read git, not the sandbox: the user's session branch (the branch
 * their apps checkout is on) when it exists in the repo, else main. Paths
 * are repo-relative and sandboxed by assertSafeRelPath (no `..`, no
 * absolute paths, nothing under .git). The app visibility rule of the app
 * tools applies: a private app another person owns, and anything else in
 * their personal tree, is invisible, as it is to app_list_apps.
 */
import { tool, type ToolSet } from "ai";
import { Types } from "mongoose";
import { z } from "zod";
import { canSeeIndexedApp } from "../../apps/app-authorization";
import { listArchivedApps } from "../../apps/app-archive.service";
import { loadAppsIndex } from "../../apps/app-index.service";
import { freshenForServe } from "../../apps/cloud-repo.service";
import { assertSafeRelPath, runGit } from "../../apps/git";
import {
  DEFAULT_BRANCH,
  globTree,
  grepTree,
  readBlob,
  resolveCommit,
} from "../../apps/repository.service";
import { loadOwnerDirectory } from "../../apps/user-handles.service";
import { boundRepoDirIfExists } from "../../apps/workspace-repo-required";
import { AppProject, AppWorktree } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { workspaceService } from "../../services/workspace.service";
import {
  GREP_MAX_LINE_CHARS,
  GREP_MAX_MATCHES,
  READ_DEFAULT_LIMIT_LINES,
  READ_MAX_CHARS,
  READ_MAX_LINE_CHARS,
  capLine,
  pageLines,
} from "./shared/output-cap";

const logger = loggers.agent();

/** Paths repo_glob returns before it says how many more matched. */
export const REPO_GLOB_MAX_PATHS = 200;
/** A file larger than this is refused by repo_read_file: grep it instead. */
export const REPO_READ_MAX_BYTES = 2 * 1024 * 1024;

export interface RepoView {
  repoDir: string;
  /** The ref every read uses. */
  ref: string;
  /** The branch name, for the result. */
  branch: string;
  isVisible: (path: string) => boolean;
}

/**
 * Whether a repo path is visible to the actor. Exported for tests: the
 * rule is pure once the hidden and shared app roots are known.
 */
export function repoPathVisibility(input: {
  /** App roots the actor may not see. */
  hiddenAppRoots: readonly string[];
  /** App roots the actor may see. */
  visibleAppRoots: readonly string[];
  /**
   * Archived app folders (`archive/...`) the actor may see, as
   * listArchivedApps decides from the original location. Everything else
   * under `archive/` is hidden.
   */
  visibleArchivedRoots?: readonly string[];
  /** The actor's own `users/<handle>` segment, when they have one. */
  ownHandle?: string;
  /** No user (a workspace API key without one): everything is visible. */
  everything?: boolean;
}): (path: string) => boolean {
  const under = (path: string, root: string) =>
    path === root || path.startsWith(`${root}/`);
  return path => {
    if (input.everything) return true;
    // A quoted path (git's escaping of non-ASCII names) matches no rule
    // below, so it would pass as visible: refuse it outright.
    if (path.startsWith('"')) return false;
    if (path === "archive" || path.startsWith("archive/")) {
      return (input.visibleArchivedRoots ?? []).some(root => under(path, root));
    }
    if (input.hiddenAppRoots.some(root => under(path, root))) return false;
    if (path === "users" || path.startsWith("users/")) {
      const handle = path.split("/")[1];
      if (handle && handle === input.ownHandle) return true;
      // Someone else's personal tree: only the apps they shared.
      return input.visibleAppRoots.some(root => under(path, root));
    }
    return true;
  };
}

async function openRepoView(
  workspaceId: string,
  userId: string | undefined,
): Promise<RepoView | { error: string }> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (!repoDir) {
    return {
      error:
        "This workspace has no repository connected, so there is no repo to read.",
    };
  }
  // Throttled; an unreachable mirror serves what the clone has.
  await freshenForServe(workspaceId).catch(() => undefined);

  let isVisible: (path: string) => boolean;
  if (!userId) {
    isVisible = repoPathVisibility({
      hiddenAppRoots: [],
      visibleAppRoots: [],
      everything: true,
    });
  } else {
    const member = await workspaceService.getMember(workspaceId, userId);
    const role = member?.role;
    if (!role) return { error: "You are not a member of this workspace." };
    const [snapshot, docs, directory, archived] = await Promise.all([
      loadAppsIndex(workspaceId),
      AppProject.find({ workspaceId: new Types.ObjectId(workspaceId) }),
      loadOwnerDirectory(workspaceId, { forUserId: userId }),
      // The Archived chip's rule: canSeeIndexedApp over the original
      // location. A failure hides the whole archive.
      listArchivedApps(workspaceId, userId, role).catch(() => []),
    ]);
    const stateById = new Map(docs.map(doc => [doc._id.toString(), doc]));
    const hiddenAppRoots: string[] = [];
    const visibleAppRoots: string[] = [];
    for (const app of snapshot.apps) {
      const visible = canSeeIndexedApp(
        app,
        stateById.get(app.appId),
        userId,
        role,
      );
      (visible ? visibleAppRoots : hiddenAppRoots).push(app.path);
    }
    isVisible = repoPathVisibility({
      hiddenAppRoots,
      visibleAppRoots,
      visibleArchivedRoots: archived.map(app => app.path),
      ownHandle: directory.handleOf(userId) ?? undefined,
    });
  }

  // The user's session branch when the repo has it, else main.
  let branch = DEFAULT_BRANCH;
  if (userId) {
    const worktree = await AppWorktree.findOne(
      { workspaceId: new Types.ObjectId(workspaceId), userId },
      { branch: 1 },
    )
      .lean()
      .catch(() => null);
    const sessionBranch = worktree?.branch;
    if (
      sessionBranch &&
      (await resolveCommit(repoDir, `refs/heads/${sessionBranch}`))
    ) {
      branch = sessionBranch;
    }
  }
  const ref = `refs/heads/${branch}`;
  if (!(await resolveCommit(repoDir, ref))) {
    return { error: "The workspace repo has no commits yet." };
  }
  return { repoDir, ref, branch, isVisible };
}

/**
 * Whether `folder` is a folder at the view's ref holding at least one path
 * the actor may see. False on any git error: the caller then answers as for
 * a missing path. Lists names only, never contents.
 */
export async function folderHasVisiblePath(
  view: RepoView,
  folder: string,
): Promise<boolean> {
  let stdout: string;
  try {
    // -z + core.quotePath=false: raw paths, so a non-ASCII hidden path
    // reaches the rule as itself, never as a quoted string.
    ({ stdout } = await runGit(
      [
        "-C",
        view.repoDir,
        "-c",
        "core.quotePath=false",
        "ls-tree",
        "-r",
        "-z",
        "--name-only",
        view.ref,
        "--",
        // The trailing slash lists the folder's contents; a file matches
        // nothing.
        `${folder}/`,
      ],
      { maxBufferBytes: 64 * 1024 * 1024 },
    ));
  } catch {
    return false;
  }
  return stdout
    .split("\0")
    .some(path => path.startsWith(`${folder}/`) && view.isVisible(path));
}

/**
 * What a repo path is to the actor: a file they may read, a folder holding
 * at least one path they may see, or missing. A hidden path reads as
 * missing, so the answer never says a private app exists.
 */
export async function pathKind(
  view: RepoView,
  relPath: string,
): Promise<"file" | "folder" | "missing"> {
  let type: string;
  try {
    const { stdout } = await runGit([
      "-C",
      view.repoDir,
      "cat-file",
      "-t",
      `${view.ref}:${relPath}`,
    ]);
    type = stdout.trim();
  } catch {
    return "missing";
  }
  if (type === "blob") return view.isVisible(relPath) ? "file" : "missing";
  // A folder counts by what it holds, not by its own name: `apps/finance`
  // around one private app passes the rule but holds nothing visible.
  if (type === "tree") {
    return (await folderHasVisiblePath(view, relPath)) ? "folder" : "missing";
  }
  return "missing";
}

/** A repo-relative directory or file to search under, validated. */
export function safePathspec(pathspec: string | undefined): string | undefined {
  if (!pathspec) return undefined;
  const trimmed = pathspec.trim().replace(/\/+$/, "");
  if (!trimmed || trimmed === ".") return undefined;
  if (trimmed.startsWith(":")) {
    throw new Error("Pathspec magic (a leading ':') is not allowed");
  }
  return assertSafeRelPath(trimmed);
}

const SEARCH_FAILED =
  "The search failed or was too broad: narrow the pattern or pass a pathspec.";

type ToolResult = { success: false; error: string } | Record<string, unknown>;

/** repo_glob over an opened view. */
export async function globRepo(
  view: RepoView,
  pattern: string,
): Promise<ToolResult> {
  // Over-fetch: hidden paths are dropped after the match.
  const fetched = REPO_GLOB_MAX_PATHS * 5;
  const matched = await globTree(view.repoDir, view.ref, pattern, fetched);
  const visible = matched.filter(view.isVisible);
  const paths = visible.slice(0, REPO_GLOB_MAX_PATHS);
  return {
    success: true,
    branch: view.branch,
    count: paths.length,
    paths,
    ...(visible.length > paths.length || matched.length >= fetched
      ? {
          truncated: true,
          note: `Stopped at ${REPO_GLOB_MAX_PATHS} paths. Narrow the pattern.`,
        }
      : {}),
  };
}

/** repo_grep over an opened view. Never returns raw git output. */
export async function grepRepo(
  view: RepoView,
  input: { pattern: string; ignoreCase?: boolean; pathspec?: string },
  /** Tests force an overflow with a tiny buffer. */
  options: { maxBufferBytes?: number } = {},
): Promise<ToolResult> {
  let pathspec: string | undefined;
  try {
    pathspec = safePathspec(input.pathspec);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Invalid pathspec",
    };
  }
  // A pathspec runs when it is a visible file or a folder holding at least
  // one visible path (`users/bob` with the one app Bob shared). A hidden
  // app, a folder holding only hidden paths and a missing path are refused
  // before git greps them, all with the same message. Matches are filtered
  // per path below, so the hidden apps of an allowed folder stay hidden.
  if (pathspec && (await pathKind(view, pathspec)) === "missing") {
    return {
      success: false,
      error: `${pathspec} not found on ${view.branch}.`,
    };
  }
  const fetched = GREP_MAX_MATCHES * 4;
  let found;
  try {
    found = await grepTree(view.repoDir, view.ref, input.pattern, {
      ignoreCase: input.ignoreCase,
      pathspec,
      // Over-fetch: hidden paths are dropped after the match.
      maxMatches: fetched,
      maxBufferBytes: options.maxBufferBytes,
    });
  } catch {
    // The git error carries the first lines of output, unfiltered.
    return { success: false, error: SEARCH_FAILED };
  }
  const visible = found.filter(m => view.isVisible(m.path));
  const truncated =
    visible.length > GREP_MAX_MATCHES || found.length >= fetched;
  const matches = visible
    .slice(0, GREP_MAX_MATCHES)
    .map(m => ({ ...m, text: capLine(m.text, GREP_MAX_LINE_CHARS) }));
  return {
    success: true,
    branch: view.branch,
    count: matches.length,
    matches,
    ...(truncated
      ? {
          truncated: true,
          note: `Stopped at ${matches.length} visible matches. Narrow the pattern or pass a pathspec.`,
        }
      : {}),
  };
}

/**
 * repo_read_file over an opened view. Files only: a visible folder gets a
 * folder message, a hidden or missing path reads as missing.
 */
export async function readRepoFile(
  view: RepoView,
  input: { path: string; offset?: number; limit?: number },
): Promise<ToolResult> {
  let relPath: string;
  try {
    relPath = assertSafeRelPath(input.path);
  } catch (error) {
    return {
      success: false,
      error: error instanceof Error ? error.message : "Invalid path",
    };
  }
  // A hidden path and a missing one read the same, so a private app never
  // leaks; the hint points at repo_glob either way.
  const missing = {
    success: false as const,
    error: `${relPath} not found on ${view.branch}. Use repo_glob to find the path.`,
  };
  // Only a blob is read: `git show` on a folder lists its children, hidden
  // apps included. The folder message names no child.
  const kind = await pathKind(view, relPath);
  if (kind === "folder") {
    return {
      success: false as const,
      error: `${relPath} is a folder, not a file. List it with repo_glob, e.g. "${relPath}/*" for its files or "${relPath}/**" for everything under it.`,
    };
  }
  if (kind === "missing") return missing;
  let blob;
  try {
    blob = await readBlob(view.repoDir, view.ref, relPath);
  } catch {
    return missing;
  }
  if (blob.isBinary) {
    return {
      success: false,
      error: `${relPath} is binary (${blob.size} bytes)`,
    };
  }
  if (blob.size > REPO_READ_MAX_BYTES) {
    return {
      success: false,
      error: `${relPath} is ${blob.size} bytes, over the ${REPO_READ_MAX_BYTES}-byte read cap. Use repo_grep with pathspec "${relPath}".`,
    };
  }
  const page = pageLines(blob.contents, {
    offset: input.offset,
    limit: input.limit,
    maxLineChars: READ_MAX_LINE_CHARS,
  });
  const contents = page.lines
    .map((l, i) => `${String(page.startLine + i).padStart(5)}\u2502${l}`)
    .join("\n");
  return {
    success: true,
    branch: view.branch,
    path: relPath,
    contents,
    ...(page.nextOffset !== undefined || page.startLine > 1
      ? {
          startLine: page.startLine,
          endLine: page.endLine,
          totalLines: page.totalLines,
          ...(page.nextOffset !== undefined
            ? { nextOffset: page.nextOffset }
            : {}),
        }
      : {}),
  };
}

export function createRepoTools(options: {
  workspaceId: string;
  userId?: string;
}): ToolSet {
  const { workspaceId, userId } = options;
  const view = () => openRepoView(workspaceId, userId);

  return {
    repo_glob: tool({
      description:
        "Find files anywhere in the workspace repo by glob (read-only): dbt models and YAML (`dbt/models/**/*.sql`), the ontology registry (`dbt/ontology/*.yml`), skills, flows, workflows, any app's bindings, personal apps included (`**/apps/**/bindings/*.sql`). Reads your session branch, else main.",
      inputSchema: z.object({
        pattern: z
          .string()
          .min(1)
          .describe("Glob over repo-relative paths, e.g. dbt/models/**/*.yml"),
      }),
      execute: async ({ pattern }) => {
        try {
          const opened = await view();
          if ("error" in opened) return { success: false, error: opened.error };
          return await globRepo(opened, pattern);
        } catch (error) {
          logger.warn("repo_glob failed", { workspaceId, error });
          return {
            success: false,
            error:
              "Could not list the repo right now: try again or narrow the pattern.",
          };
        }
      },
    }),

    repo_grep: tool({
      description:
        "Search file contents anywhere in the workspace repo with an extended regex (read-only). Returns path:line:text matches. Use pathspec to stay in one folder (e.g. `dbt/models`). Reads your session branch, else main.",
      inputSchema: z.object({
        pattern: z.string().min(1).describe("Extended-regex pattern"),
        ignoreCase: z.boolean().optional(),
        pathspec: z
          .string()
          .optional()
          .describe("Repo-relative folder or file to search, e.g. dbt/models"),
      }),
      execute: async input => {
        try {
          const opened = await view();
          if ("error" in opened) return { success: false, error: opened.error };
          return await grepRepo(opened, input);
        } catch (error) {
          logger.warn("repo_grep failed", { workspaceId, error });
          return { success: false, error: SEARCH_FAILED };
        }
      },
    }),

    repo_read_file: tool({
      description: `Read one file anywhere in the workspace repo (read-only), line-numbered. Returns up to ${READ_DEFAULT_LIMIT_LINES} lines or ~${READ_MAX_CHARS / 1000}k chars per call; pass \`nextOffset\` as \`offset\` to continue. Reads your session branch, else main.`,
      inputSchema: z.object({
        path: z
          .string()
          .min(1)
          .describe("Repo-relative path, e.g. dbt/ontology/terms.yml"),
        offset: z
          .number()
          .int()
          .positive()
          .optional()
          .describe("1-based line to start reading from (default 1)"),
        limit: z
          .number()
          .int()
          .positive()
          .optional()
          .describe(
            `Maximum lines to return (default ${READ_DEFAULT_LIMIT_LINES})`,
          ),
      }),
      execute: async input => {
        try {
          const opened = await view();
          if ("error" in opened) return { success: false, error: opened.error };
          return await readRepoFile(opened, input);
        } catch (error) {
          logger.warn("repo_read_file failed", { workspaceId, error });
          return {
            success: false,
            error: "Could not read the file right now: try again.",
          };
        }
      },
    }),
  };
}

/**
 * Apps v2 agent tools (apps-v2.md §4.6) — experimental, flag-gated.
 *
 * This is the "real filesystem + real shell" tool contract that replaces the
 * ~15 bespoke v1 app tools:
 *
 *   app2_bash        — the workhorse: any shell command in the app's sandbox
 *                      session (grep, ls, sed, node, package managers, ...)
 *   app2_read_file / app2_write_file / app2_edit_file
 *                    — fast paths that skip shell quoting pitfalls
 *   app2_status / app2_commit
 *                    — durable-worktree status and WIP→branch commit (CAS)
 *   app2_list_apps / app2_create_app
 *
 * Everything executes server-side (headless-safe). Reads resolve through the
 * durable worktree layer (bare repo + WIP refs), so results are identical
 * whether a sandbox session is warm or was rebuilt after eviction. Every
 * mutation ends with a flush to the private WIP ref — that flush IS the
 * durability watermark.
 *
 * Apps v1 tools are untouched and the two suites coexist (tool-family
 * isolation keeps a turn on one system's tools; see modes/registry.ts).
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Types } from "mongoose";
import { applyStrReplace, buildStrReplaceDiff } from "@mako/agent-tools";
import {
  AppProjectV2,
  type IAppProjectV2,
} from "../../database/workspace-schema";
import { workspaceService } from "../../services/workspace.service";
import { canReadResource, canWriteResource } from "../../utils/resource-acl";
import {
  WorktreeConflictError,
  chatActorFor,
  chatBranchFor,
  commitWorktree,
  createProject,
  ensureWorktree,
  execInWorktree,
  globFiles,
  grepFiles,
  listBranches,
  listFiles,
  mergeBranchToMain,
  readFile,
  readSessionFile,
  worktreeStatus,
  writeFile,
} from "../../apps-v2/worktree.service";
import { materializeAppV2Binding } from "../../apps-v2/bindings.service";
import { loggers } from "../../logging";

const logger = loggers.agent();

export interface AppsV2ToolsOptions {
  workspaceId: string;
  userId?: string;
  chatId?: string;
}

type LoadResult = { project: IAppProjectV2 } | { error: string };

export function createAppsV2Tools({
  workspaceId,
  userId,
  chatId,
}: AppsV2ToolsOptions): ToolSet {
  // Cursor-cloud model: each chat conversation is its own actor working on
  // its own `chat/<chatId>` branch (forked off main on first touch). The
  // chat-finalization hook commits the accumulated WIP at the end of every
  // turn, so each turn becomes one commit on the conversation branch. Non-chat
  // callers fall back to a per-user worktree on the default branch.
  const actorId = chatId ? chatActorFor(chatId) : (userId ?? "api-key");
  const actorBranch = chatId ? chatBranchFor(chatId) : undefined;
  const ensureActorWorktree = (project: IAppProjectV2) =>
    ensureWorktree(project, actorId, { branch: actorBranch });

  // Read-before-edit freshness tracking (a Claude Code reliability hallmark):
  // the agent must read a file before a blind full-rewrite, so it never
  // clobbers content it hasn't seen this turn. Anchored edits are inherently
  // safe (they fail on a bad anchor) so they don't require a prior read.
  // Scoped to this tool-factory instance = the current turn.
  const readThisTurn = new Set<string>();
  const markRead = (appId: string, path: string) =>
    readThisTurn.add(`${appId}\u0000${path}`);
  const wasRead = (appId: string, path: string) =>
    readThisTurn.has(`${appId}\u0000${path}`);

  let cachedRole: string | undefined | null = null;
  const memberRole = async (): Promise<string | undefined> => {
    if (cachedRole !== null) return cachedRole;
    if (!userId) {
      cachedRole = undefined;
      return undefined;
    }
    const member = await workspaceService.getMember(workspaceId, userId);
    cachedRole = member?.role;
    return cachedRole;
  };

  const loadProject = async (
    appId: string,
    opts: { write: boolean },
  ): Promise<LoadResult> => {
    if (!appId || !Types.ObjectId.isValid(appId)) {
      return { error: `Invalid app id: ${appId}. Use app2_list_apps first.` };
    }
    const project = await AppProjectV2.findOne({
      _id: new Types.ObjectId(appId),
      workspaceId: new Types.ObjectId(workspaceId),
    });
    if (!project) {
      return { error: `App ${appId} not found. Use app2_list_apps.` };
    }
    if (userId) {
      const role = await memberRole();
      const allowed = opts.write
        ? canWriteResource(project, userId, role)
        : canReadResource(project, userId, role);
      if (!allowed) {
        return { error: `App ${appId} not found. Use app2_list_apps.` };
      }
    }
    return { project };
  };

  const errorMessage = (error: unknown): string => {
    if (error instanceof WorktreeConflictError) return error.message;
    return error instanceof Error ? error.message : String(error);
  };

  return {
    app2_list_apps: tool({
      description:
        "List Apps v2 (git-backed) projects in the workspace. Distinct from v1 list_open_apps.",
      inputSchema: z.object({}),
      execute: async () => {
        const docs = await AppProjectV2.find({
          workspaceId: new Types.ObjectId(workspaceId),
        }).sort({ updatedAt: -1 });
        const role = await memberRole();
        const visible = docs.filter(
          d => !userId || canReadResource(d, userId, role),
        );
        return {
          success: true,
          apps: visible.map(d => ({
            id: d._id.toString(),
            title: d.title,
            description: d.description,
            updatedAt: d.updatedAt,
          })),
        };
      },
    }),

    app2_create_app: tool({
      description:
        "Create a new Apps v2 project: a real Vite + React + TypeScript app in a Mako-managed git repository (package.json, scripts, lockfile-ready). Returns the app id used by every other app2_* tool.",
      inputSchema: z.object({
        title: z.string().min(1).describe("Human-readable app title"),
        description: z.string().optional(),
      }),
      execute: async ({ title, description }) => {
        try {
          const project = await createProject({
            workspaceId,
            title,
            description,
            userId,
          });
          const { entries } = await listFiles(project, actorId);
          return {
            success: true,
            appId: project._id.toString(),
            title: project.title,
            files: entries.map(e => e.path),
            note: "Real project: use app2_bash for shell commands (ls, grep, npm install, npm run build, ...), app2_write_file/app2_edit_file for edits, app2_commit to commit.",
          };
        } catch (error) {
          logger.error("app2_create_app failed", { error });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app2_bash: tool({
      description:
        "Run a bash command in the app's sandbox session. cwd is the APP's folder (apps/<slug>) inside the workspace repo, not the repo root, so package.json and src/ are right here and `cwd` is interpreted relative to it. Use for anything a developer would do in a terminal: ls, grep, sed, cat, node, npm/pnpm install, npm run build, git status/log/diff. File changes are flushed to the app's durable WIP snapshot after the command. Each call is a one-shot command: backgrounding a long-running process (`vite &`) does NOT leave a server running the user can reach — use the app's preview controls for that. Not for committing (use app2_commit) and not for pushing (the session has no remote credentials).",
      inputSchema: z.object({
        appId: z.string().describe("Apps v2 project id"),
        command: z.string().min(1).describe("Bash command line to execute"),
        cwd: z
          .string()
          .optional()
          .describe("Working directory relative to the repo root"),
        timeoutSeconds: z
          .number()
          .int()
          .positive()
          .max(600)
          .optional()
          .describe("Kill the command after this many seconds (default 120)"),
      }),
      execute: async ({ appId, command, cwd, timeoutSeconds }) => {
        const loaded = await loadProject(appId, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const handle = await ensureActorWorktree(loaded.project);
          const result = await execInWorktree(handle, command, {
            cwd,
            timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
          });
          return {
            success: result.exitCode === 0,
            exitCode: result.exitCode,
            stdout: result.stdout,
            stderr: result.stderr,
            timedOut: result.timedOut,
            truncated: result.truncated,
            durationMs: result.durationMs,
            durableRevision: result.flush.revision,
          };
        } catch (error) {
          logger.error("app2_bash failed", { error, appId });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app2_read_file: tool({
      description:
        "Read a file from an Apps v2 project at the latest durable state (committed + uncommitted). Prefer this over `app2_bash cat` for single files. Returns line-numbered content by default so you can make precise anchored edits.",
      inputSchema: z.object({
        appId: z.string(),
        path: z
          .string()
          .min(1)
          .describe("Repo-relative path, e.g. src/App.tsx"),
        withLineNumbers: z
          .boolean()
          .optional()
          .describe("Prefix each line with its 1-based number (default true)"),
      }),
      execute: async ({ appId, path: relPath, withLineNumbers }) => {
        const loaded = await loadProject(appId, { write: false });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const file = await readFile(loaded.project, relPath, actorId);
          if (file.isBinary) {
            return {
              success: false,
              error: `${relPath} is binary (${file.size} bytes)`,
            };
          }
          markRead(appId, file.path);
          const numbered = withLineNumbers !== false;
          const contents = numbered
            ? file.contents
                .split("\n")
                .map((l, i) => `${String(i + 1).padStart(5)}\u2502${l}`)
                .join("\n")
            : file.contents;
          return {
            success: true,
            path: file.path,
            contents,
            lineNumbered: numbered,
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app2_glob: tool({
      description:
        "Find files by glob pattern in an Apps v2 project (e.g. `src/**/*.tsx`, `**/*.css`). Reads from git, so it works even when the sandbox is paused or dead. Fast way to locate files before reading/editing.",
      inputSchema: z.object({
        appId: z.string(),
        pattern: z.string().min(1).describe("Glob, e.g. src/**/*.ts"),
      }),
      execute: async ({ appId, pattern }) => {
        const loaded = await loadProject(appId, { write: false });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const paths = await globFiles(loaded.project, pattern, actorId);
          return { success: true, count: paths.length, paths };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app2_grep: tool({
      description:
        "Search file contents in an Apps v2 project with a regex (extended). Returns path:line:text matches. Reads from git (sandbox-independent). Prefer this over `app2_bash grep` for codebase search.",
      inputSchema: z.object({
        appId: z.string(),
        pattern: z.string().min(1).describe("Extended-regex pattern"),
        ignoreCase: z.boolean().optional(),
        pathspec: z
          .string()
          .optional()
          .describe("Limit to a path glob, e.g. 'src/'"),
      }),
      execute: async ({ appId, pattern, ignoreCase, pathspec }) => {
        const loaded = await loadProject(appId, { write: false });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const matches = await grepFiles(loaded.project, pattern, actorId, {
            ignoreCase,
            pathspec,
          });
          return { success: true, count: matches.length, matches };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app2_write_file: tool({
      description:
        "Create or fully overwrite a file in an Apps v2 project. The change is flushed to the durable WIP snapshot immediately. For surgical edits prefer app2_edit_file.",
      inputSchema: z.object({
        appId: z.string(),
        path: z.string().min(1),
        contents: z.string(),
      }),
      execute: async ({ appId, path: relPath, contents }) => {
        const loaded = await loadProject(appId, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          // Read-before-overwrite guard (Claude Code hallmark): a full rewrite
          // of an EXISTING file it hasn't read this turn risks clobbering
          // content blindly. Creating a new file is fine. Anchored edits are
          // exempt (they fail safely on a bad anchor).
          if (!wasRead(appId, relPath)) {
            let exists = false;
            try {
              await readFile(loaded.project, relPath, actorId);
              exists = true;
            } catch {
              exists = false;
            }
            if (exists) {
              return {
                success: false,
                error: `${relPath} already exists and was not read this turn. Read it first (app2_read_file) so you don't overwrite content blindly, or use app2_edit_file for a targeted change.`,
              };
            }
          }
          const handle = await ensureActorWorktree(loaded.project);
          const flush = await writeFile(handle, relPath, contents);
          markRead(appId, relPath);
          return {
            success: true,
            path: relPath,
            durableRevision: flush.revision,
          };
        } catch (error) {
          logger.error("app2_write_file failed", { error, appId });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app2_edit_file: tool({
      description:
        "Anchored string-replacement edit of a file in an Apps v2 project (like str_replace). oldString must match exactly once unless replaceAll is set. Flushed to the durable WIP snapshot immediately.",
      inputSchema: z.object({
        appId: z.string(),
        path: z.string().min(1),
        oldString: z.string().min(1),
        newString: z.string(),
        replaceAll: z.boolean().optional(),
      }),
      execute: async ({
        appId,
        path: relPath,
        oldString,
        newString,
        replaceAll,
      }) => {
        const loaded = await loadProject(appId, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const handle = await ensureActorWorktree(loaded.project);
          let current: string;
          try {
            current = await readSessionFile(handle, relPath);
          } catch {
            return { success: false, error: `File not found: ${relPath}` };
          }
          const result = applyStrReplace(
            current,
            oldString,
            newString,
            replaceAll ?? false,
          );
          if (!result.ok) return { success: false, error: result.error };
          const flush = await writeFile(handle, relPath, result.contents);
          return {
            success: true,
            path: relPath,
            replacements: result.replacements,
            diff: buildStrReplaceDiff(
              current,
              oldString,
              newString,
              result.replacements,
            ),
            durableRevision: flush.revision,
          };
        } catch (error) {
          logger.error("app2_edit_file failed", { error, appId });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app2_status: tool({
      description:
        "Show an Apps v2 worktree's durable status: base commit, WIP snapshot, changed files vs base, and whether the branch has moved.",
      inputSchema: z.object({ appId: z.string() }),
      execute: async ({ appId }) => {
        const loaded = await loadProject(appId, { write: false });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const status = await worktreeStatus(loaded.project, actorId);
          return { success: true, status };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app2_list_branches: tool({
      description:
        "List all branches of an Apps v2 project: the default branch (main) plus one `chat/<id>` branch per conversation that edited the app, with ahead-of-main counts. Use before merging.",
      inputSchema: z.object({ appId: z.string() }),
      execute: async ({ appId }) => {
        const loaded = await loadProject(appId, { write: false });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const branches = await listBranches(loaded.project);
          return {
            success: true,
            branches,
            currentBranch: actorBranch ?? "main",
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app2_merge_to_main: tool({
      description:
        "Merge a branch of an Apps v2 project into main (fast-forward when possible, real merge commit otherwise; refuses on conflicts). Use when the user is happy with this conversation's changes and wants them on main. Omit `branch` to merge THIS conversation's branch.",
      inputSchema: z.object({
        appId: z.string(),
        branch: z
          .string()
          .optional()
          .describe("Branch to merge (defaults to this conversation's branch)"),
      }),
      execute: async ({ appId, branch }) => {
        const loaded = await loadProject(appId, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        const target = branch ?? actorBranch;
        if (!target) {
          return {
            success: false,
            error:
              "No branch specified and this session has no conversation branch.",
          };
        }
        try {
          const result = await mergeBranchToMain(loaded.project, target);
          return { success: result.merged, ...result, branch: target };
        } catch (error) {
          logger.error("app2_merge_to_main failed", { error, appId });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app2_materialize: tool({
      description:
        "Build (or rebuild) the parquet artifact for a data binding of an Apps v2 project. Bindings are files: bindings/<name>.sql with '-- connection: <id>' front matter (see the apps-v2 skill). Reads THIS conversation's branch, so it works before merging to main. The build runs synchronously against the warehouse (read-only enforced) and the preview serves the result at __data/<name>.parquet.",
      inputSchema: z.object({
        appId: z.string(),
        name: z.string().describe("Binding name (= filename without .sql)"),
      }),
      execute: async ({ appId, name }) => {
        const loaded = await loadProject(appId, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const result = await materializeAppV2Binding(
            loaded.project,
            name,
            actorId,
          );
          return { success: true, ...result };
        } catch (error) {
          logger.error("app2_materialize failed", { error, appId });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app2_commit: tool({
      description:
        "Commit the current WIP snapshot of an Apps v2 project onto this conversation's branch with a message (compare-and-swap; fails cleanly if the branch moved). Note: uncommitted work is auto-committed at the end of every turn anyway; use this for meaningful mid-turn checkpoints with a good message.",
      inputSchema: z.object({
        appId: z.string(),
        message: z.string().min(1).describe("Commit message"),
      }),
      execute: async ({ appId, message }) => {
        const loaded = await loadProject(appId, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const handle = await ensureActorWorktree(loaded.project);
          const result = await commitWorktree(handle, message);
          return { success: result.committed, ...result };
        } catch (error) {
          logger.error("app2_commit failed", { error, appId });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),
  };
}

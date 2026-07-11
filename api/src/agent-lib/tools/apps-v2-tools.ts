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
 * All tools are inert (absent) unless APPS_V2_ENABLED is set; apps v1 tools
 * are untouched and the two suites coexist.
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
import { isAppsV2Enabled } from "../../apps-v2/config";
import {
  WorktreeConflictError,
  commitWorktree,
  createProject,
  ensureWorktree,
  execInWorktree,
  listFiles,
  readFile,
  readSessionFile,
  worktreeStatus,
  writeFile,
} from "../../apps-v2/worktree.service";
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
}: AppsV2ToolsOptions): ToolSet {
  if (!isAppsV2Enabled()) return {};

  // The worktree actor: per-user when we know the user, else a stable
  // API-key pseudo-actor (matches the routes' behavior).
  const actorId = userId ?? "api-key";

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
        "Run a bash command inside the app's sandbox session working tree (cwd = repo root). Use for anything a developer would do in a terminal: ls, grep, sed, cat, node, npm/pnpm install, npm run build, git status/log/diff. File changes are automatically flushed to the app's durable WIP snapshot after the command. Not for committing (use app2_commit) and not for pushing (the session has no remote credentials).",
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
          const handle = await ensureWorktree(loaded.project, actorId);
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
        "Read a file from an Apps v2 project at the latest durable state (committed + uncommitted). Prefer this over `app2_bash cat` for single files.",
      inputSchema: z.object({
        appId: z.string(),
        path: z.string().min(1).describe("Repo-relative path, e.g. src/App.tsx"),
      }),
      execute: async ({ appId, path: relPath }) => {
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
          return { success: true, path: file.path, contents: file.contents };
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
          const handle = await ensureWorktree(loaded.project, actorId);
          const flush = await writeFile(handle, relPath, contents);
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
      execute: async ({ appId, path: relPath, oldString, newString, replaceAll }) => {
        const loaded = await loadProject(appId, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const handle = await ensureWorktree(loaded.project, actorId);
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

    app2_commit: tool({
      description:
        "Commit the current WIP snapshot of an Apps v2 project onto its branch with a message (compare-and-swap; fails cleanly if the branch moved). This is the durable checkpoint users see in history.",
      inputSchema: z.object({
        appId: z.string(),
        message: z.string().min(1).describe("Commit message"),
      }),
      execute: async ({ appId, message }) => {
        const loaded = await loadProject(appId, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const handle = await ensureWorktree(loaded.project, actorId);
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

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
 * Everything executes server-side (headless-safe). The agent works the way a
 * developer does: it edits files in a checkout, runs commands in a shell, and
 * commits. The checkout is the sandbox, which is an ordinary clone with an
 * ordinary remote, so `git push` is what makes work durable — there is no
 * separate snapshot step and nothing to reconcile.
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
  commitWorktree,
  catchUpLiveBox,
  createProject,
  synthesizeProjectFromFolder,
  listAppFolders,
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
import { ensureDevServer } from "../../apps-v2/dev-server.service";
import { publishRealtimeEvent } from "../../services/realtime.service";
import { loggers } from "../../logging";

const logger = loggers.agent();

export interface AppsV2ToolsOptions {
  workspaceId: string;
  userId?: string;
}

type LoadResult = { project: IAppProjectV2 } | { error: string };

export function createAppsV2Tools({
  workspaceId,
  userId,
}: AppsV2ToolsOptions): ToolSet {
  // A conversation is not a line of work.
  //
  // Chats used to get their own `chat/<chatId>` branch. That made opening a
  // chat fork the code — including when you open one merely to clear context,
  // which is most of the time — and split the agent's work from the user's
  // own: they edited the same app from two branches and each saw an app the
  // other had not touched. It also forked the WHOLE workspace monorepo, every
  // app in it, for a conversation about one of them.
  //
  // So the agent works where the user works: their branch, their checkout,
  // like any other pair of hands on a repository. The end-of-turn commit is
  // unchanged, and still gives one commit per turn to review or revert.
  const actorId = userId ?? "api-key";
  const ensureActorWorktree = (project: IAppProjectV2) =>
    ensureWorktree(project, actorId);
  // The branch is whatever the checkout is on — main by default, or wherever
  // the user (or this agent, via `git checkout` in app2_bash) switched to.
  // Read it fresh per call; a cached value goes stale the moment anyone
  // switches branches mid-conversation.
  const currentActorBranch = async (project: IAppProjectV2) =>
    (await ensureActorWorktree(project)).doc.branch;

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
    if (!appId) {
      return { error: `Invalid app: ${appId}. Use app2_list_apps first.` };
    }
    // An app is a FOLDER (apps-v2.md §13.6), so `apps/<name>` is its identity
    // and that is what an agent working in a checkout actually has. Accept the
    // folder name, tolerate an `apps/` prefix, and still resolve legacy ids.
    const ref = appId.replace(/^apps\//, "");
    const project =
      (Types.ObjectId.isValid(ref)
        ? await AppProjectV2.findOne({
            _id: new Types.ObjectId(ref),
            workspaceId: new Types.ObjectId(workspaceId),
          })
        : await AppProjectV2.findOne({
            slug: ref,
            workspaceId: new Types.ObjectId(workspaceId),
          })) ??
      // No row: the app may exist only as a folder in the repo, which is the
      // normal case for anything created from a local checkout.
      (await synthesizeProjectFromFolder(workspaceId, ref));
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
        // The repo is the list: an app is a folder under apps/ (§13.6), so
        // one written straight into a checkout and pushed shows up here with
        // no registration step.
        const folders = await listAppFolders(workspaceId);
        const docs = await AppProjectV2.find({
          workspaceId: new Types.ObjectId(workspaceId),
        });
        const stateBySlug = new Map(
          docs.filter(d => d.slug).map(d => [d.slug as string, d]),
        );
        const role = await memberRole();
        return {
          success: true,
          apps: folders
            .filter(f => {
              const state = stateBySlug.get(f.slug);
              if (!state) return true;
              return !userId || canReadResource(state, userId, role);
            })
            .map(f => ({
              app: f.slug,
              path: `apps/${f.slug}`,
              title: f.title,
              description: f.description,
            })),
        };
      },
    }),

    app2_create_app: tool({
      description:
        "Create a new app: a real Vite + React + TypeScript project scaffolded into apps/<name>/ in the workspace repo. The FOLDER is the app — creating one is just committing that directory, and you can equally create it yourself with app2_bash + app2_write_file. Returns the folder name that every other app2_* tool takes.",
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
          // The scaffold just landed on main server-side. If this actor's
          // sandbox is RUNNING, reads are served from it — and it has not
          // heard yet, so without a catch-up the brand-new app lists as
          // empty and the agent rebuilds the scaffold by hand over it.
          await catchUpLiveBox(project, actorId);
          const { entries } = await listFiles(project, actorId);
          return {
            success: true,
            app: project.slug ?? project._id.toString(),
            path: `apps/${project.slug ?? project._id.toString()}`,
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
        "Run a bash command in the app's sandbox session. cwd is the APP's folder (apps/<slug>) inside the workspace repo, not the repo root, so package.json and src/ are right here and `cwd` is interpreted relative to it. Use for anything a developer would do in a terminal: ls, grep, sed, cat, node, npm/pnpm install, npm run build, git status/log/diff. Each call is a one-shot command: backgrounding a long-running process (`vite &`) does NOT leave a server running the user can reach — use the app's preview controls for that. Git is fully yours: commit with app2_commit or run git yourself — branch, checkout, merge, push; the sandbox is a real clone with a real remote. Note the checkout is SHARED with the user, so a branch switch changes what they see too — do it when the task calls for it, and say so.",
      inputSchema: z.object({
        appId: z
          .string()
          .describe(
            'The app\'s folder name under apps/ — e.g. "hello-world" for apps/hello-world. That folder IS the app. A legacy id also resolves.',
          ),
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
        "Create or fully overwrite a file in an Apps v2 project's working copy. Uncommitted until you commit, like any checkout. For surgical edits prefer app2_edit_file.",
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
          await writeFile(handle, relPath, contents);
          markRead(appId, relPath);
          return { success: true, path: relPath };
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
          await writeFile(handle, relPath, result.contents);
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

    app2_open_app: tool({
      description:
        "Open an Apps v2 app in the user's Mako UI — focuses its tab — and " +
        "(by default) start its live dev session (vite + HMR) so the user " +
        "watches edits apply live in the preview. Use it after creating an " +
        "app or when asked to show one. Returns the dev preview URL. " +
        "Distinct from the v1 open_app/run_app tools, which cannot see " +
        "git-backed apps.",
      inputSchema: z.object({
        appId: z.string(),
        dev: z
          .boolean()
          .optional()
          .describe("Also start the live dev session (default true)."),
      }),
      execute: async ({ appId, dev }) => {
        const loaded = await loadProject(appId, { write: false });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const handle = await ensureActorWorktree(loaded.project);
          let url: string | undefined;
          let evicted: string[] | undefined;
          if (dev !== false) {
            // The same launch the workbench button runs — this call IS the
            // user's click, relayed through their agent (§13.9: starts are
            // user-initiated; this is one).
            const preview = await ensureDevServer(handle);
            url = preview.url;
            evicted = preview.evicted;
          }
          // The tab opens in the USER'S browser: a user-scoped UI intent on
          // the workspace channel. Headless callers (MCP) have no browser
          // listening and simply use the returned URL.
          publishRealtimeEvent(workspaceId, {
            type: "app-v2.open-app",
            userId: actorId,
            appId: String(loaded.project._id ?? loaded.project.slug ?? appId),
            slug: loaded.project.slug ?? undefined,
            title: loaded.project.title ?? undefined,
          });
          return {
            success: true,
            app: loaded.project.slug,
            title: loaded.project.title,
            devServerUrl: url,
            evicted,
            hint:
              dev !== false
                ? "The app tab is open in the user's Mako UI with the live " +
                  "dev session running — file edits hot-reload there."
                : "The app tab is open in the user's Mako UI.",
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app2_list_branches: tool({
      description:
        "List all branches of an Apps v2 project with ahead-of-main counts, plus the branch this session's checkout is on. Branching is git-native: create or switch branches with `git checkout` in app2_bash, exactly as on a laptop.",
      inputSchema: z.object({ appId: z.string() }),
      execute: async ({ appId }) => {
        const loaded = await loadProject(appId, { write: false });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const branches = await listBranches(loaded.project);
          return {
            success: true,
            branches,
            currentBranch: await currentActorBranch(loaded.project),
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app2_merge_to_main: tool({
      description:
        "Merge a branch of an Apps v2 project into main (fast-forward when possible, real merge commit otherwise; refuses on conflicts). Use when the user is happy with the changes and wants them on main. Omit `branch` to merge the branch you are working on.",
      inputSchema: z.object({
        appId: z.string(),
        branch: z
          .string()
          .optional()
          .describe("Branch to merge (defaults to the branch you are on)"),
      }),
      execute: async ({ appId, branch }) => {
        const loaded = await loadProject(appId, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        const target = branch ?? (await currentActorBranch(loaded.project));
        if (target === (loaded.project.defaultBranch || "main")) {
          return {
            success: false,
            error:
              "Already on the default branch - there is nothing to merge. Commit with app2_commit instead.",
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

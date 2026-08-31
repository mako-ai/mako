/**
 * Apps agent tools (apps.md §4.6).
 *
 * NOT flag-gated at this layer: `settings.appsEnabled` only hides the UI
 * rail (status-probe route). Agents and MCP clients can drive Apps in any
 * workspace — deliberate, so external automation works ahead of UI rollout.
 *
 * The "real filesystem + real shell" tool contract:
 *
 *   app_bash        — the workhorse: any shell command in the app's sandbox
 *                      session (grep, ls, sed, node, package managers, ...)
 *   app_read_file / app_write_file / app_edit_file
 *                    — fast paths that skip shell quoting pitfalls
 *   app_status / app_commit
 *                    — durable-worktree status and WIP→branch commit (CAS)
 *   app_list_apps / app_create_app
 *
 * Everything executes server-side (headless-safe). The agent works the way a
 * developer does: it edits files in a checkout, runs commands in a shell, and
 * commits. The checkout is the sandbox, which is an ordinary clone with an
 * ordinary remote, so `git push` is what makes work durable — there is no
 * separate snapshot step and nothing to reconcile.
 *
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { Types } from "mongoose";
import { applyStrReplace, buildStrReplaceDiff } from "@mako/agent-tools";
import { AppProject, type IAppProject } from "../../database/workspace-schema";
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
} from "../../apps/worktree.service";
import { materializeAppBinding } from "../../apps/bindings.service";
import {
  devConsolePath,
  devLogPath,
  ensureDevServer,
} from "../../apps/dev-server.service";
import { getDashboardArtifactStore } from "../../services/dashboard-artifact-store.service";
import { browseApp, eyesShotKey } from "../../apps/eyes.service";
import { publishRealtimeEvent } from "../../services/realtime.service";
import { loggers } from "../../logging";

const logger = loggers.agent();

export interface AppsToolsOptions {
  workspaceId: string;
  userId?: string;
  /** Resolved model accepts image input; undefined = assume yes (external MCP). */
  supportsVision?: boolean;
}

type LoadResult = { project: IAppProject } | { error: string };

export function createAppsTools({
  workspaceId,
  userId,
  supportsVision,
}: AppsToolsOptions): ToolSet {
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
  const ensureActorWorktree = (project: IAppProject) =>
    ensureWorktree(project, actorId);
  // The branch is whatever the checkout is on — main by default, or wherever
  // the user (or this agent, via `git checkout` in app_bash) switched to.
  // Read it fresh per call; a cached value goes stale the moment anyone
  // switches branches mid-conversation.
  const currentActorBranch = async (project: IAppProject) =>
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
      return { error: `Invalid app: ${appId}. Use app_list_apps first.` };
    }
    // An app is a FOLDER (apps.md §13.6), so `apps/<name>` is its identity
    // and that is what an agent working in a checkout actually has. Accept the
    // folder name, tolerate an `apps/` prefix, and still resolve legacy ids.
    const ref = appId.replace(/^apps\//, "");
    const project =
      (Types.ObjectId.isValid(ref)
        ? await AppProject.findOne({
            _id: new Types.ObjectId(ref),
            workspaceId: new Types.ObjectId(workspaceId),
          })
        : await AppProject.findOne({
            slug: ref,
            workspaceId: new Types.ObjectId(workspaceId),
          })) ??
      // No row: the app may exist only as a folder in the repo, which is the
      // normal case for anything created from a local checkout.
      (await synthesizeProjectFromFolder(workspaceId, ref));
    if (!project) {
      return { error: `App ${appId} not found. Use app_list_apps.` };
    }
    if (userId) {
      const role = await memberRole();
      const allowed = opts.write
        ? canWriteResource(project, userId, role)
        : canReadResource(project, userId, role);
      if (!allowed) {
        return { error: `App ${appId} not found. Use app_list_apps.` };
      }
    }
    return { project };
  };

  const errorMessage = (error: unknown): string => {
    if (error instanceof WorktreeConflictError) return error.message;
    return error instanceof Error ? error.message : String(error);
  };

  return {
    app_list_apps: tool({
      description: "List Apps (git-backed) projects in the workspace.",
      inputSchema: z.object({}),
      execute: async () => {
        // The repo is the list: an app is a folder under apps/ (§13.6), so
        // one written straight into a checkout and pushed shows up here with
        // no registration step.
        const folders = await listAppFolders(workspaceId);
        const docs = await AppProject.find({
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

    app_create_app: tool({
      description:
        "Create a new app: a real Vite + React + TypeScript project scaffolded into apps/<name>/ in the workspace repo. The FOLDER is the app — creating one is just committing that directory, and you can equally create it yourself with app_bash + app_write_file. Returns the folder name that every other app_* tool takes.",
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
            note: "Real project: use app_bash for shell commands (ls, grep, npm install, npm run build, ...), app_write_file/app_edit_file for edits, app_commit to commit.",
          };
        } catch (error) {
          logger.error("app_create_app failed", { error });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app_bash: tool({
      description:
        "Run a bash command in the app's sandbox session. cwd is the APP's folder (apps/<slug>) inside the workspace repo, not the repo root, so package.json and src/ are right here and `cwd` is interpreted relative to it. Use for anything a developer would do in a terminal: ls, grep, sed, cat, node, npm/pnpm install, npm run build, git status/log/diff. Each call is a one-shot command: backgrounding a long-running process (`vite &`) does NOT leave a server running the user can reach — use the app's preview controls for that. Git is fully yours: commit with app_commit or run git yourself — branch, checkout, merge, push; the sandbox is a real clone with a real remote. Note the checkout is SHARED with the user, so a branch switch changes what they see too — do it when the task calls for it, and say so.",
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
          logger.error("app_bash failed", { error, appId });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app_read_file: tool({
      description:
        "Read a file from an Apps project at the latest durable state (committed + uncommitted). Prefer this over `app_bash cat` for single files. Returns line-numbered content by default so you can make precise anchored edits.",
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

    app_glob: tool({
      description:
        "Find files by glob pattern in an Apps project (e.g. `src/**/*.tsx`, `**/*.css`). Reads from git, so it works even when the sandbox is paused or dead. Fast way to locate files before reading/editing.",
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

    app_grep: tool({
      description:
        "Search file contents in an Apps project with a regex (extended). Returns path:line:text matches. Reads from git (sandbox-independent). Prefer this over `app_bash grep` for codebase search.",
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

    app_write_file: tool({
      description:
        "Create or fully overwrite a file in an Apps project's working copy. Uncommitted until you commit, like any checkout. For surgical edits prefer app_edit_file.",
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
                error: `${relPath} already exists and was not read this turn. Read it first (app_read_file) so you don't overwrite content blindly, or use app_edit_file for a targeted change.`,
              };
            }
          }
          const handle = await ensureActorWorktree(loaded.project);
          await writeFile(handle, relPath, contents);
          markRead(appId, relPath);
          return { success: true, path: relPath };
        } catch (error) {
          logger.error("app_write_file failed", { error, appId });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app_edit_file: tool({
      description:
        "Anchored string-replacement edit of a file in an Apps project (like str_replace). oldString must match exactly once unless replaceAll is set. Flushed to the durable WIP snapshot immediately.",
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
          logger.error("app_edit_file failed", { error, appId });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app_status: tool({
      description:
        "Show an Apps worktree's durable status: base commit, WIP snapshot, changed files vs base, and whether the branch has moved.",
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

    app_dev_log: tool({
      description:
        "Read the app's dev-server output (vite boot, compile errors, HMR " +
        "messages) AND the browser runtime console (errors/warnings the " +
        "live preview reported). The fastest way to see WHY an app is " +
        "broken or blank. Needs a dev session (app_open_app starts one).",
      inputSchema: z.object({
        appId: z.string(),
        bytes: z
          .number()
          .int()
          .min(500)
          .max(60000)
          .optional()
          .describe("How much of the log tail to read (default 16000)."),
      }),
      execute: async ({ appId, bytes }) => {
        const loaded = await loadProject(appId, { write: false });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const handle = await ensureActorWorktree(loaded.project);
          const n = bytes ?? 16_000;
          const out = await execInWorktree(
            handle,
            `tail -c ${n} ${JSON.stringify(devLogPath(handle))} 2>/dev/null; ` +
              `printf '\\n===MAKO-CONSOLE===\\n'; ` +
              `tail -c 12000 ${JSON.stringify(devConsolePath(handle))} 2>/dev/null`,
            { timeoutMs: 30_000 },
          );
          const [rawLog = "", rawConsole = ""] =
            out.stdout.split("===MAKO-CONSOLE===");
          // The recording is a raw pty capture; ANSI escapes are noise here.
          const ansi = new RegExp(
            String.fromCharCode(27) + "\\[[0-9;?]*[A-Za-z]",
            "g",
          );
          const devLog = rawLog.replace(ansi, "").replace(/\r/g, "");
          const browserConsole = rawConsole
            .split("\n")
            .map(l => l.trim())
            .filter(Boolean)
            .map(l => {
              try {
                return JSON.parse(l) as unknown;
              } catch {
                return null;
              }
            })
            .filter(Boolean)
            .slice(-80);
          return {
            success: true,
            devLog,
            browserConsole,
            hint:
              browserConsole.length === 0
                ? "No browser console events captured — either the app " +
                  "logged no errors/warnings, or no live preview (workbench " +
                  "iframe or app_browse) has loaded it since the dev " +
                  "session started. An empty file after the app rendered " +
                  "in a preview means it is clean."
                : undefined,
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app_browse: tool({
      description:
        "Look at the running app with a real headless browser INSIDE its " +
        "sandbox: navigate, click, type, evaluate JS, then capture a " +
        "screenshot (you SEE it) plus console errors and failed requests. " +
        "Use it after edits to verify what actually renders, and to debug " +
        "blank screens. Needs a running dev session (app_open_app). First " +
        "use in a fresh sandbox installs the browser (~30-60s). If your " +
        "model cannot read images, pass screenshot:false — pageText, " +
        "console and failed requests still tell you what rendered.",
      inputSchema: z.object({
        appId: z.string(),
        steps: z
          .array(
            z.object({
              action: z.enum(["navigate", "click", "type", "wait", "eval"]),
              selector: z
                .string()
                .optional()
                .describe("CSS selector (click/type)."),
              path: z.string().optional().describe("Route path (navigate)."),
              value: z.string().optional().describe("Text to type."),
              expression: z
                .string()
                .optional()
                .describe("JS to evaluate in the page (eval)."),
              ms: z.number().int().max(5000).optional().describe("Wait ms."),
            }),
          )
          .max(10)
          .optional()
          .describe("Actions before the capture; omit to just look at /."),
        screenshot: z
          .boolean()
          .optional()
          .describe("Capture a JPEG screenshot (default true)."),
        origin: z
          .enum(["local", "public"])
          .optional()
          .describe(
            "local (default) hits the dev server inside the sandbox — " +
              "debugs the app itself. public goes through the sandbox's " +
              "public URL — the exact path the user's browser takes, so it " +
              "also verifies the proxy/edge (use when the user reports the " +
              "preview broken but the app looks fine locally).",
          ),
      }),
      execute: async ({ appId, steps, screenshot, origin }) => {
        const loaded = await loadProject(appId, { write: false });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const handle = await ensureActorWorktree(loaded.project);
          const result = await browseApp(handle, {
            steps,
            screenshot: screenshot !== false,
            origin,
          });
          // Screenshots persist as bucket objects, never as stored base64:
          // the URL survives in chat history (the persistence sanitizer
          // drops the base64), and the serving route re-authorizes reads.
          let screenshotUrl: string | undefined;
          if (result.screenshotBase64) {
            try {
              const shotId = `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
              const key = eyesShotKey(
                loaded.project._id.toString(),
                `${shotId}.jpg`,
              );
              await getDashboardArtifactStore().putBuffer(
                Buffer.from(result.screenshotBase64, "base64"),
                key,
                "image/jpeg",
              );
              screenshotUrl = `/api/workspaces/${workspaceId}/apps/${loaded.project._id.toString()}/eyes-shots/${shotId}.jpg`;
            } catch (uploadError) {
              logger.warn("Could not store the browse screenshot", {
                error: errorMessage(uploadError),
              });
            }
          }
          return { success: result.ok, ...result, screenshotUrl };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
      // The screenshot must reach the model as an IMAGE, not as 100KB of
      // base64 prose: as text it is ~25k tokens of noise the model cannot
      // see through; as media it is actual eyes.
      toModelOutput: ({ output }) => {
        const o = output as { screenshotBase64?: string } & Record<
          string,
          unknown
        >;
        // A text-only model receiving an image part loses the whole result
        // (§13.26): vision-less models get text (pageText + screenshotUrl)
        // only. undefined = assume vision (external MCP clients).
        if (supportsVision === false && o && typeof o === "object") {
          const { screenshotBase64: _omitted, ...rest } = o;
          return { type: "json", value: rest as never };
        }
        if (o && typeof o === "object" && o.screenshotBase64) {
          const { screenshotBase64, ...rest } = o;
          return {
            type: "content",
            value: [
              { type: "text", text: JSON.stringify(rest) },
              {
                type: "file-data",
                data: screenshotBase64,
                mediaType: "image/jpeg",
                filename: "app-screenshot.jpg",
              },
            ],
          };
        }
        return { type: "json", value: (o ?? null) as never };
      },
    }),

    app_open_app: tool({
      description:
        "Open an Apps app in the user's Mako UI — focuses its tab — and " +
        "(by default) start its live dev session (vite + HMR) so the user " +
        "watches edits apply live in the preview. Use it after creating an " +
        "app or when asked to show one. Returns the dev preview URL. " +
        "Starts (or reuses) the dev server for the app and focuses its tab in " +
        "git-backed apps.",
      inputSchema: z.object({
        appId: z.string(),
        dev: z
          .boolean()
          .optional()
          .describe("Also start the live dev session (default true)."),
        restart: z
          .boolean()
          .optional()
          .describe(
            "Stop a running dev server first and boot a fresh one — use " +
              "when the server is wedged or must pick up new launcher " +
              "behavior.",
          ),
      }),
      execute: async ({ appId, dev, restart }) => {
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
            const preview = await ensureDevServer(handle, {
              restart: restart === true,
            });
            url = preview.url;
            evicted = preview.evicted;
          }
          // The tab opens in the USER'S browser: a user-scoped UI intent on
          // the workspace channel. Headless callers (MCP) have no browser
          // listening and simply use the returned URL.
          publishRealtimeEvent(workspaceId, {
            type: "app.open-app",
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

    app_list_branches: tool({
      description:
        "List all branches of an Apps project with ahead-of-main counts, plus the branch this session's checkout is on. Branching is git-native: create or switch branches with `git checkout` in app_bash, exactly as on a laptop.",
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

    app_merge_to_main: tool({
      description:
        "Merge a branch of an Apps project into main (fast-forward when possible, real merge commit otherwise; refuses on conflicts). Use when the user is happy with the changes and wants them on main. Omit `branch` to merge the branch you are working on.",
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
              "Already on the default branch - there is nothing to merge. Commit with app_commit instead.",
          };
        }
        try {
          const result = await mergeBranchToMain(loaded.project, target);
          return { success: result.merged, ...result, branch: target };
        } catch (error) {
          logger.error("app_merge_to_main failed", { error, appId });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app_materialize: tool({
      description:
        "Build (or rebuild) the parquet artifact for a data binding of an Apps project. Bindings are files: bindings/<name>.sql with '-- connection: <id>' front matter (see the apps skill). Reads THIS conversation's branch, so it works before merging to main. The build runs synchronously against the warehouse (read-only enforced) and the preview serves the result at __data/<name>.parquet.",
      inputSchema: z.object({
        appId: z.string(),
        name: z.string().describe("Binding name (= filename without .sql)"),
      }),
      execute: async ({ appId, name }) => {
        const loaded = await loadProject(appId, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const result = await materializeAppBinding(
            loaded.project,
            name,
            actorId,
          );
          return { success: true, ...result };
        } catch (error) {
          logger.error("app_materialize failed", { error, appId });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app_commit: tool({
      description:
        "Commit the current WIP snapshot of an Apps project onto this conversation's branch with a message (compare-and-swap; fails cleanly if the branch moved). Note: uncommitted work is auto-committed at the end of every turn anyway; use this for meaningful mid-turn checkpoints with a good message.",
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
          logger.error("app_commit failed", { error, appId });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),
  };
}

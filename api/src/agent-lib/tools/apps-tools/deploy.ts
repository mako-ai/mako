/**
 * Status, publishing and its logs: app_status, app_publish_status,
 * app_publish, app_build_log, app_dev_log.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  ensureWorktree,
  execInWorktree,
  worktreeStatus,
  PUBLISH_ACTOR,
  boxCtx,
  appRootFor,
} from "../../../apps/worktree.service";
import {
  DEFAULT_BRANCH,
  repoDirFor,
  resolveCommit,
} from "../../../apps/repository.service";
import { freshenForServe } from "../../../apps/cloud-repo.service";
import { buildLogPath } from "../../../apps/deployment.service";
import { publishState } from "../../../apps/publish-state";
import {
  describeDeployProgress,
  isDeployInFlight,
} from "../../../apps/deploy-progress";
import { getSandboxProvider } from "../../../apps/sandbox/provider";
import { devConsolePath, devLogPath } from "../../../apps/dev-server.service";
import { type AppsToolContext } from "./context";

export function appDeployTools(ctx: AppsToolContext): ToolSet {
  const {
    targetInput,
    actorId,
    ensureActorWorktree,
    loadProject,
    loadTarget,
    scopeFor,
    errorMessage,
  } = ctx;
  return {
    app_status: tool({
      description:
        "Show an Apps worktree's durable status: base commit, WIP snapshot, changed files vs base, and whether the branch has moved. " +
        "`changes` is THIS app's uncommitted slice; `repoChanges` is the whole shared working copy — entries outside this app usually belong to the user or one of their other chats, and are not yours to commit, revert, or clean. " +
        "This is the SANDBOX's git state, not what is deployed — for the live app's published commit, use app_publish_status.",
      inputSchema: z.object(targetInput),
      execute: async ({ appId, workflowId }) => {
        const loaded = await loadTarget(
          { appId, workflowId },
          { write: false },
        );
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const status = await worktreeStatus(
            scopeFor(loaded.project),
            actorId,
          );
          // The working copy is shared (user + their other chats), so foreign
          // WIP is normal. Say so explicitly — without this, agents read a
          // stranger's dirty files (or a turn commit they didn't make) as
          // corruption and burn turns "fixing" it.
          const root = `${appRootFor(loaded.project)}/`;
          const foreign =
            status?.repoChanges.filter(ch => !ch.path.startsWith(root))
              .length ?? 0;
          return {
            success: true,
            status,
            hint:
              foreign > 0
                ? `${foreign} uncommitted change(s) elsewhere in the repo (outside ${appRootFor(loaded.project)}) — likely the user's or a concurrent chat's in-flight work. Leave them alone: don't commit, revert, or clean them. Your end-of-turn auto-commit only includes apps you touched this turn.`
                : undefined,
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app_publish_status: tool({
      description:
        "What is LIVE for this app: the published deployment's commit sha vs the tip of the default branch. " +
        "A push to the default branch builds and publishes automatically; when the branch is ahead of the published sha, " +
        "the newest commits are still building or the build/data preparation failed — `lastDeployError` then names the stage (bindings/build) and the error; app_build_log has the full build output. " +
        "While a deploy is in flight, `deploy` names its sha and stage (queued, bindings, build or publishing) with timestamps, `bindings` {prepared, total, current} during data preparation, a one-line `summary`, and `stalled` when the stage has had no progress for too long. " +
        "`bindingRefreshFailures` lists tables of the live commit serving old numbers because their rebuild failed. " +
        "For the sandbox worktree's own git state, use app_status.",
      inputSchema: z.object({ appId: z.string() }),
      execute: async ({ appId }) => {
        const loaded = await loadProject(appId, { write: false });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          // Pull the cloud mirror first (interval 0): the serving instance
          // may not have seen the push this status call is asking about
          // (#894's race).
          const status = await publishState(loaded.project, 0);
          return { success: true, status };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app_publish: tool({
      description:
        "Deploy the app's default branch NOW. Enqueues the exact build+deploy " +
        "the push webhook uses (single-build concurrency per app, so it never " +
        "races a push-triggered build) and returns immediately with the " +
        "enqueued sha — poll app_publish_status until publishedSha reaches it " +
        "(typically under 2 minutes; only a parquet binding with no artifact at that " +
        "exact commit blocks the release, a stale scheduled artifact goes live and " +
        "refreshes behind it, and a failing build or binding surfaces in " +
        "app_build_log). A deploy of this sha that is still progressing is left to " +
        "finish and reported as `alreadyInFlight`. Use when a push's automatic deploy " +
        "did not land, or to force a redeploy of the current branch tip. Needs edit access to the app.",
      inputSchema: z.object({ appId: z.string() }),
      execute: async ({ appId }) => {
        const loaded = await loadProject(appId, { write: true, deploy: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const project = loaded.project;
          const branch = project.defaultBranch || DEFAULT_BRANCH;
          // Force-freshen before resolving: this tool exists precisely for
          // "the push's automatic deploy did not land", which is also when
          // this instance may not have pulled that push yet — without this
          // we would enqueue the PREVIOUS sha and report success.
          await freshenForServe(project.workspaceId.toString(), 0);
          const sha = await resolveCommit(
            repoDirFor(project.workspaceId.toString()),
            `refs/heads/${branch}`,
          );
          if (!sha) {
            return { success: false, error: `branch ${branch} has no commits` };
          }
          if (isDeployInFlight(project.deployProgress, sha)) {
            return {
              success: true,
              alreadyInFlight: true,
              enqueued: { branch, sha },
              deploy: describeDeployProgress(
                project.deployProgress,
                project.publishedSha ?? null,
              ),
              message:
                "A deploy of this sha is already running. Poll app_publish_status " +
                "until publishedSha reaches it.",
            };
          }
          const { requestAppDeploys } =
            await import("../../../inngest/functions/apps-deploy");
          await requestAppDeploys(
            project.workspaceId.toString(),
            [project._id.toString()],
            sha,
            "manual",
          );
          return {
            success: true,
            enqueued: { branch, sha },
            message:
              "Deploy enqueued. Poll app_publish_status until publishedSha " +
              "reaches this sha; if it does not land, read app_build_log.",
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app_build_log: tool({
      description:
        "Tail the PUBLISH build log (npm install + build output from the " +
        "shared publish sandbox) — the first place to look when app_publish " +
        "or a push deploy does not land; `lastDeployError` in the result is " +
        "the recorded reason (binding or build) even when the sandbox is asleep. " +
        "Distinct from app_dev_log (the dev " +
        "server's log). Never starts a sandbox: an empty result means no " +
        "publish build has run recently.",
      inputSchema: z.object({
        appId: z.string(),
        offset: z
          .number()
          .int()
          .min(0)
          .optional()
          .describe(
            "Byte offset to tail from (default 0; use the returned size to poll).",
          ),
      }),
      execute: async ({ appId, offset }) => {
        const loaded = await loadProject(appId, { write: false });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const lastDeployError = loaded.project.lastDeployError ?? null;
          const handle = await ensureWorktree(loaded.project, PUBLISH_ACTOR);
          const ctx = boxCtx(handle);
          if (!(await getSandboxProvider().hasSession(ctx))) {
            return { success: true, size: 0, chunk: "", lastDeployError };
          }
          const start = (offset ?? 0) + 1;
          const result = await getSandboxProvider().exec(
            ctx,
            `wc -c < ${buildLogPath(handle)} 2>/dev/null || echo 0; ` +
              `tail -c +${start} ${buildLogPath(handle)} 2>/dev/null | head -c 65536`,
            { timeoutMs: 30_000 },
          );
          const newline = result.stdout.indexOf("\n");
          const size = Number(result.stdout.slice(0, newline).trim()) || 0;
          return {
            success: true,
            size,
            chunk: result.stdout.slice(newline + 1),
            lastDeployError,
          };
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
  };
}

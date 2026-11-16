/**
 * The workspace shell: the caller's own sandbox, at the root of the
 * workspace repo instead of one app's or one workflow's folder.
 *
 *   sandbox_status      — is the box up, which branch, what changed
 *   sandbox_bash        — one shell command, cwd relative to the repo root
 *   sandbox_read_file   — a file of the working copy, uncommitted edits in
 *   sandbox_write_file  — create or replace a file (left uncommitted)
 *
 * Nothing new runs here. The box is the one app_bash and workflow_bash
 * already use: one E2B microVM per (workspace, person), holding a clone of
 * the whole workspace repo (ensureWorkspaceWorktree is the handle without
 * an app lens).
 *
 * The rules, on top of app_bash's:
 * - A person only, with at least the member role, read live.
 * - Reads and writes follow the repo's visibility rule (repo-tools.ts
 *   repoPathVisibility): another member's private app is "not found".
 *   The box holds a full clone, so a shell could read such an app anyway:
 *   sandbox_bash is refused outright while any app the caller cannot see
 *   exists in the repo.
 * - In the in-app chat, sandbox_bash and sandbox_write_file ask the user
 *   first (AI SDK `needsApproval`, the approval card MCP tools use). Over
 *   MCP the client's own tool approval is that confirmation.
 * - A commit a command leaves on main never reaches main: it goes to a new
 *   `sandbox/<handle>/<stamp>-<sha>` branch and main goes back to origin's,
 *   compared against `git ls-remote`, not the local tracking ref. The step
 *   runs even when the command fails, and holds the box's push lock from
 *   the command's start, so a concurrent app_bash cannot push it first.
 * - Credentials are redacted from every output and from the log line.
 * - Each command is logged: who, where, which branch, exit code, time.
 */
import { tool, type ToolSet } from "ai";
import { Types } from "mongoose";
import { z } from "zod";
import { hasMinimumWorkspaceRole } from "@mako/agent-tools";

import { canSeeIndexedApp } from "../../apps/app-authorization";
import { listArchivedApps } from "../../apps/app-archive.service";
import { loadAppsIndex } from "../../apps/app-index.service";
import { boxPushIfAhead } from "../../apps/box";
import { redactGitSecrets } from "../../apps/git";
import { DEFAULT_BRANCH } from "../../apps/repository.service";
import { getSandboxProvider } from "../../apps/sandbox/provider";
import {
  handleForUser,
  loadOwnerDirectory,
} from "../../apps/user-handles.service";
import {
  boxCtx,
  ensureBox,
  ensureWorkspaceWorktree,
  execInWorktree,
  readSessionFile,
  withBoxPushLock,
  writeFile,
  writeWorktreeScratchFile,
  type WorktreeHandle,
} from "../../apps/worktree.service";
import { AppProject } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { workspaceService } from "../../services/workspace.service";
import {
  BASH_STDERR_HEAD_CHARS,
  BASH_STDERR_MAX_CHARS,
  BASH_STDOUT_HEAD_CHARS,
  BASH_STDOUT_MAX_CHARS,
  READ_DEFAULT_LIMIT_LINES,
  READ_MAX_CHARS,
  capText,
  pageLines,
} from "./shared/output-cap";
import {
  FULL_OUTPUT_FILES_KEPT,
  contentHash,
  safeFileStem,
} from "./apps-tools/context";
import { repoPathVisibility } from "./repo-tools";

const logger = loggers.agent();

/** The longest command text kept in the log line. */
const LOGGED_COMMAND_CHARS = 2_000;
/** Marks the hash of a read whose text was redacted: never writable back. */
const REDACTED_HASH_PREFIX = "redacted-";
/** Changed files listed by sandbox_status. */
const STATUS_MAX_CHANGES = 200;
/** The settle step's own time budget (ls-remote, fetch, push, reset). */
const SETTLE_TIMEOUT_MS = 120_000;
/** Command timeout ceiling where the caller sets none (in-app chat). */
const DEFAULT_MAX_TIMEOUT_SECONDS = 600;

/**
 * Credentials as they show up in a box or a command: Mako's git token
 * (`mgt_`), Mako API keys (`revops_`), Stripe keys, Slack bot tokens, AWS
 * access keys, bearer headers and basic-auth URLs (redactGitSecrets).
 */
export function redactSandboxSecrets(text: string): string {
  return redactGitSecrets(text)
    .replace(/\bmgt_[A-Za-z0-9._~+/=-]{8,}/g, "mgt_[REDACTED]")
    .replace(/\brevops_[A-Za-z0-9_-]{16,}/g, "revops_[REDACTED]")
    .replace(/\b([sr]k_(?:live|test)_)[A-Za-z0-9]{8,}/g, "$1[REDACTED]")
    .replace(/\b(xox[abposr]-)[A-Za-z0-9-]{8,}/g, "$1[REDACTED]")
    .replace(/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "[REDACTED-AWS-KEY]")
    .replace(
      /\b(aws_secret_access_key\s*[=:]\s*)[A-Za-z0-9/+=]{30,}/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(bearer\s+)[A-Za-z0-9._~+/=-]{16,}/gi, "$1[REDACTED]");
}

const failure = (error: unknown) => ({
  success: false as const,
  error: redactSandboxSecrets(
    error instanceof Error ? error.message : String(error),
  ),
});

/**
 * `sandbox/<handle>/<UTC stamp>`: the start of the branch a commit made on
 * main moves to. The settle script appends `-<short sha>`, so two moves in
 * the same second never share a name.
 */
export function sandboxBranchPrefix(owner: string, now = new Date()): string {
  const safe = owner
    .replace(/[^A-Za-z0-9._-]/g, "-")
    .replace(/\.{2,}/g, ".")
    .replace(/^[.-]+|[.]+$/g, "");
  const stamp = now
    .toISOString()
    .replace(/[-:]/g, "")
    .replace(/\.\d+Z$/, "Z");
  return `sandbox/${safe || "user"}/${stamp}`;
}

/**
 * Runs after every command, at the repo root, with hooks off (a command may
 * have installed one). It prints one line:
 *
 *   OFFMAIN <branch>   not on main: the caller pushes the session branch
 *   CLEAN              on main, nothing origin's main lacks
 *   UNVERIFIED         on main, origin's main unreadable: nothing pushed
 *   MOVED <n> <keep|soft> <pushed 0|1> <branch>
 *
 * Origin's main is read with `git ls-remote`, never from
 * refs/remotes/origin/main, which the command could have moved or deleted.
 * Moved commits go to `<prefix>-<short sha>`, pushed by explicit refspec;
 * main is reset to origin's (`--keep` keeps uncommitted edits, `--soft` is
 * the fallback) and the tracking ref is restored. Nothing here ever pushes
 * while on main.
 */
export function settleMainScript(prefix: string): string {
  const main = DEFAULT_BRANCH;
  const git = "git -c core.hooksPath=/dev/null";
  return [
    `b=$(${git} symbolic-ref --short -q HEAD || true)`,
    `if [ "$b" != "${main}" ]; then echo "OFFMAIN $b"; exit 0; fi`,
    `r=$(${git} ls-remote origin refs/heads/${main} 2>/dev/null | cut -f1)`,
    `if [ -z "$r" ]; then echo UNVERIFIED; exit 0; fi`,
    `${git} cat-file -e "$r^{commit}" 2>/dev/null || ${git} fetch -q origin ${main} 2>/dev/null`,
    `if ! ${git} cat-file -e "$r^{commit}" 2>/dev/null; then echo UNVERIFIED; exit 0; fi`,
    `n=$(${git} rev-list --count "$r"..HEAD)`,
    `if [ "$n" -eq 0 ]; then ${git} update-ref refs/remotes/origin/${main} "$r"; echo CLEAN; exit 0; fi`,
    `br="${prefix}-$(${git} rev-parse --short=8 HEAD)"`,
    `${git} branch -f "$br" HEAD`,
    `if ${git} push -q origin "refs/heads/$br:refs/heads/$br" >/dev/null 2>&1; then p=1; else p=0; fi`,
    `if ${git} reset -q --keep "$r" 2>/dev/null; then m=keep; else ${git} reset -q --soft "$r"; m=soft; fi`,
    `${git} update-ref refs/remotes/origin/${main} "$r"`,
    `echo "MOVED $n $m $p $br"`,
  ].join("\n");
}

type Settled =
  | { state: "offmain"; branch: string }
  | { state: "clean" }
  | { state: "unverified" }
  | {
      state: "moved";
      commits: number;
      mode: "keep" | "soft";
      pushed: boolean;
      branch: string;
    };

export function parseSettled(stdout: string): Settled {
  const line = stdout.trim().split("\n").filter(Boolean).pop() ?? "";
  const moved = /^MOVED (\d+) (keep|soft) ([01]) (\S+)$/.exec(line);
  if (moved) {
    return {
      state: "moved",
      commits: Number(moved[1]),
      mode: moved[2] as "keep" | "soft",
      pushed: moved[3] === "1",
      branch: moved[4],
    };
  }
  if (line === "CLEAN") return { state: "clean" };
  const off = /^OFFMAIN ?(.*)$/.exec(line);
  // A detached HEAD prints an empty name: no branch to push.
  if (off) return { state: "offmain", branch: off[1].trim() };
  // Anything else (the step failed, timed out, printed nothing): unknown,
  // so nothing is pushed.
  return { state: "unverified" };
}

/** A porcelain status line's path(s): `XY path` or `XY from -> to`. */
function statusPaths(line: string): string[] {
  return line
    .slice(3)
    .split(" -> ")
    .map(path => path.trim());
}

interface SandboxView {
  isVisible: (path: string) => boolean;
  /** Apps (live or archived) in the repo this person may not see. */
  hiddenApps: number;
}

/**
 * The repo as this person may see it: repo_read_file's rule, plus how many
 * apps it hides. Fails closed: an index that cannot be read hides nothing it
 * should show, but counts as hiding something, so sandbox_bash is refused.
 */
async function loadSandboxView(
  workspaceId: string,
  userId: string,
  role: string,
): Promise<SandboxView> {
  try {
    const [snapshot, docs, directory, visibleArchived, allArchived] =
      await Promise.all([
        loadAppsIndex(workspaceId),
        AppProject.find({ workspaceId: new Types.ObjectId(workspaceId) }),
        loadOwnerDirectory(workspaceId, { forUserId: userId }),
        listArchivedApps(workspaceId, userId, role),
        // No user: every archived app, to count the hidden ones.
        listArchivedApps(workspaceId, undefined, role),
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
    const visibleArchivedRoots = visibleArchived.map(app => app.path);
    return {
      isVisible: repoPathVisibility({
        hiddenAppRoots,
        visibleAppRoots,
        visibleArchivedRoots,
        ownHandle: directory.handleOf(userId) ?? undefined,
      }),
      hiddenApps:
        hiddenAppRoots.length +
        Math.max(0, allArchived.length - visibleArchivedRoots.length),
    };
  } catch (error) {
    logger.warn("sandbox: could not compute repo visibility", {
      workspaceId,
      error: error instanceof Error ? error.message : String(error),
    });
    return { isVisible: () => false, hiddenApps: 1 };
  }
}

export function createSandboxTools({
  workspaceId,
  userId,
  maxTimeoutSeconds = DEFAULT_MAX_TIMEOUT_SECONDS,
}: {
  workspaceId: string;
  userId?: string;
  /**
   * Ceiling on a command's timeout. MCP passes ~100 s: an MCP exchange is
   * cut at 120 s, and a client retrying a cut call would otherwise run the
   * command twice (the push lock queues the retry behind the first).
   */
  maxTimeoutSeconds?: number;
}): ToolSet {
  const defaultTimeoutSeconds = Math.min(120, maxTimeoutSeconds);

  /**
   * The caller's own box, or why not. A person only: a workspace API key
   * with no person behind it would share one box with every other such key.
   * The role is read live: a key outlives the membership that justified it.
   */
  const openOwnBox = async (): Promise<
    | { handle: WorktreeHandle; view: SandboxView; userId: string }
    | { error: string }
  > => {
    if (!userId) {
      return {
        error:
          "The sandbox belongs to a person. This credential is not tied to one, so it has no sandbox.",
      };
    }
    const member = await workspaceService.getMember(workspaceId, userId);
    const role = member?.role;
    if (!role || !hasMinimumWorkspaceRole(role, "member")) {
      return {
        error: `The sandbox needs at least the member role (you are ${role ?? "not a member"}).`,
      };
    }
    const [handle, view] = await Promise.all([
      ensureWorkspaceWorktree(workspaceId, userId),
      loadSandboxView(workspaceId, userId, role),
    ]);
    return { handle, view, userId };
  };

  /** A path this person may touch, or the refusal. */
  const refusePath = (view: SandboxView, path: string): string | null => {
    const normalized = path.replace(/\\/g, "/").replace(/^\.\//, "");
    if (!view.isVisible(normalized)) return `${path} not found.`;
    const base = normalized.split("/").pop() ?? "";
    if (base === ".env" || base.startsWith(".env.")) {
      return `${path} is an env file. Secrets do not go through the sandbox file tools.`;
    }
    return null;
  };

  const branchPrefix = async () =>
    sandboxBranchPrefix(
      (await handleForUser(workspaceId, userId).catch(() => undefined)) ??
        userId ??
        "user",
    );

  return {
    sandbox_status: tool({
      description:
        "Show your workspace sandbox: whether it is running, the branch its checkout is on, its root path, commits ahead of and behind origin, the uncommitted files across the repo (those you may see), and which of node, python3, dbt, uv and bq it has. Pass start: true to boot it. One sandbox per person and workspace, shared with your app_bash, workflow_bash and the Mako terminal; it pauses after 10 idle minutes and keeps its files.",
      inputSchema: z.object({
        start: z
          .boolean()
          .optional()
          .describe("Boot the sandbox when it is not running"),
      }),
      execute: async ({ start }) => {
        try {
          const opened = await openOwnBox();
          if ("error" in opened) return { success: false, error: opened.error };
          const { handle, view } = opened;
          const provider = getSandboxProvider();
          if (start) await ensureBox(handle);
          const ctx = boxCtx(handle);
          if (!(await provider.hasSession(ctx))) {
            return {
              success: true,
              running: false,
              branch: handle.doc.branch,
              note: "Not running. sandbox_status({ start: true }) or a sandbox_bash call boots it.",
            };
          }
          const result = await execInWorktree(
            handle,
            [
              "echo BRANCH $(git symbolic-ref --short -q HEAD || echo HEAD)",
              "echo HEAD $(git rev-parse --short HEAD)",
              "echo COUNTS $(git rev-list --left-right --count @{u}...HEAD 2>/dev/null || echo '- -')",
              "for t in node python3 dbt uv bq; do echo TOOL $t $(command -v $t >/dev/null && echo 1 || echo 0); done",
              `git status --porcelain=v1 | head -n 2000 | sed 's/^/CHANGE /'`,
            ].join("; "),
            { timeoutMs: 30_000, pushIfAhead: false },
          );
          const lines = result.stdout.split("\n");
          const field = (key: string) =>
            lines
              .find(line => line.startsWith(`${key} `))
              ?.slice(key.length + 1)
              .trim();
          const [behind, ahead] = (field("COUNTS") ?? "- -").split(/\s+/);
          const changes = lines
            .filter(line => line.startsWith("CHANGE "))
            .map(line => line.slice("CHANGE ".length))
            .filter(line => statusPaths(line).every(view.isVisible));
          return {
            success: true,
            running: true,
            root: provider.root(ctx),
            branch: field("BRANCH") ?? handle.doc.branch,
            head: field("HEAD"),
            ahead: Number.isFinite(Number(ahead)) ? Number(ahead) : undefined,
            behind: Number.isFinite(Number(behind))
              ? Number(behind)
              : undefined,
            changes: redactSandboxSecrets(
              changes.slice(0, STATUS_MAX_CHANGES).join("\n"),
            )
              .split("\n")
              .filter(Boolean),
            ...(changes.length > STATUS_MAX_CHANGES
              ? { changesTruncated: true }
              : {}),
            tools: Object.fromEntries(
              lines
                .filter(line => line.startsWith("TOOL "))
                .map(line => {
                  const [, name, has] = line.split(" ");
                  return [name, has === "1"];
                }),
            ),
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    sandbox_bash: tool({
      description: `Run one bash command in your workspace sandbox (an E2B Linux VM with a clone of the whole workspace repo), starting at the repo root; \`cwd\` is relative to it. For what spans the repo: git status/log/diff, scripts under scripts/, python3 or node one-offs, \`pip install --user\` then dbt parse. Each call needs the user's confirmation: in Mako's chat an approval card, over MCP your client's own tool approval. The checkout is the one your app_bash, workflow_bash and the Mako terminal share: dirty files you did not make are someone's in-flight work, leave them. Commits never stay on main: a commit left on main moves to a new sandbox/<you>/<time>-<sha> branch (pushed) and main goes back to origin's; the result names the branch. Ship through app_merge_to_main or workflow_merge_to_main, never \`git push\` to main. Refused while the repo holds an app you may not see. Output is capped (start and end kept, the full text saved in the sandbox) and credentials in it are redacted. Default timeout ${defaultTimeoutSeconds} s, at most ${maxTimeoutSeconds} s. Each call is logged.`,
      needsApproval: true,
      inputSchema: z.object({
        command: z.string().min(1).describe("Bash command line to execute"),
        cwd: z
          .string()
          .optional()
          .describe("Working directory relative to the repo root"),
        timeoutSeconds: z
          .number()
          .int()
          .positive()
          .max(maxTimeoutSeconds)
          .optional()
          .describe(
            `Kill the command after this many seconds (default ${defaultTimeoutSeconds}, at most ${maxTimeoutSeconds})`,
          ),
      }),
      execute: async ({ command, cwd, timeoutSeconds }, { toolCallId }) => {
        const started = Date.now();
        const loggedCommand = redactSandboxSecrets(command).slice(
          0,
          LOGGED_COMMAND_CHARS,
        );
        try {
          if (cwd && (cwd.startsWith("/") || cwd.split("/").includes(".."))) {
            return {
              success: false,
              error: `cwd must be a path inside the repo, relative to its root: ${cwd}`,
            };
          }
          const opened = await openOwnBox();
          if ("error" in opened) return { success: false, error: opened.error };
          const { handle, view } = opened;
          if (view.hiddenApps > 0) {
            return {
              success: false,
              error: `sandbox_bash is off in this workspace for you: the repo holds ${view.hiddenApps} app(s) you may not see (another member's private apps, or archived ones), and the sandbox holds a full clone a shell could read them from. sandbox_read_file and sandbox_write_file still work on what you may see.`,
            };
          }
          if (cwd && !view.isVisible(cwd)) {
            return { success: false, error: `${cwd} not found.` };
          }
          const prefix = await branchPrefix();
          const ctx = boxCtx(handle);

          // The push lock is held from the command's start to the end of the
          // settle step: a concurrent app_bash cannot push a commit this
          // command leaves on main before it moves to a branch.
          const { result, settled } = await withBoxPushLock(
            ctx.sessionKey,
            async () => {
              let ran: Awaited<ReturnType<typeof execInWorktree>> | undefined;
              let thrown: unknown;
              try {
                ran = await execInWorktree(handle, command, {
                  cwd,
                  timeoutMs:
                    Math.min(
                      timeoutSeconds ?? defaultTimeoutSeconds,
                      maxTimeoutSeconds,
                    ) * 1000,
                  pushIfAhead: false,
                });
              } catch (error) {
                thrown = error;
              }
              // Runs whether the command succeeded, failed or threw.
              let settledNow: Settled = { state: "unverified" };
              try {
                const out = await execInWorktree(
                  handle,
                  settleMainScript(prefix),
                  { timeoutMs: SETTLE_TIMEOUT_MS, pushIfAhead: false },
                );
                settledNow = parseSettled(out.stdout);
              } catch (error) {
                logger.warn("sandbox_bash settle step failed", {
                  workspaceId,
                  userId,
                  error: redactSandboxSecrets(
                    error instanceof Error ? error.message : String(error),
                  ),
                });
              }
              // On a branch that is not main: commits there are the
              // session's own work, pushed as app_bash pushes them. Never
              // on main, never when the state is unknown.
              if (
                settledNow.state === "offmain" &&
                settledNow.branch &&
                settledNow.branch !== DEFAULT_BRANCH
              ) {
                await boxPushIfAhead(ctx).catch(error =>
                  logger.warn(
                    "sandbox_bash could not push the session branch",
                    {
                      error:
                        error instanceof Error ? error.message : String(error),
                    },
                  ),
                );
              }
              if (thrown !== undefined) throw thrown;
              return { result: ran!, settled: settledNow };
            },
          );

          const fullStdout = redactSandboxSecrets(result.stdout);
          const fullStderr = redactSandboxSecrets(result.stderr);
          const stdout = capText(fullStdout, {
            maxChars: BASH_STDOUT_MAX_CHARS,
            headChars: BASH_STDOUT_HEAD_CHARS,
          });
          const stderr = capText(fullStderr, {
            maxChars: BASH_STDERR_MAX_CHARS,
            headChars: BASH_STDERR_HEAD_CHARS,
          });
          let fullOutputPath: string | undefined;
          if (stdout.truncated || stderr.truncated) {
            fullOutputPath = await writeWorktreeScratchFile(
              handle,
              `mako-tool-output/${safeFileStem(toolCallId)}.log`,
              `$ ${redactSandboxSecrets(command)}\n\n=== stdout ===\n${fullStdout}\n\n=== stderr ===\n${fullStderr}\n`,
              { keepNewest: FULL_OUTPUT_FILES_KEPT },
            ).catch(() => undefined);
          }

          logger.info("sandbox_bash", {
            workspaceId,
            userId,
            branch: handle.doc.branch,
            cwd: cwd ?? "",
            command: loggedCommand,
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: Date.now() - started,
            settled: settled.state,
            ...(settled.state === "moved"
              ? { movedOffMain: settled.commits, to: settled.branch }
              : {}),
          });

          return {
            success: result.exitCode === 0,
            exitCode: result.exitCode,
            stdout: stdout.text,
            stderr: stderr.text,
            timedOut: result.timedOut,
            truncated: result.truncated,
            durationMs: result.durationMs,
            ...(settled.state === "moved"
              ? {
                  movedOffMain: {
                    commits: settled.commits,
                    branch: settled.branch,
                    pushed: settled.pushed,
                    note:
                      `The command committed on ${DEFAULT_BRANCH}. Those ${settled.commits} commit(s) are on ${settled.branch}` +
                      (settled.pushed
                        ? " (pushed)"
                        : " (NOT pushed: they exist only in this sandbox; push the branch)") +
                      `, and ${DEFAULT_BRANCH} is back to origin's` +
                      (settled.mode === "soft"
                        ? "; their changes also stay in the checkout as uncommitted edits."
                        : ".") +
                      " Merge with app_merge_to_main or workflow_merge_to_main when the user agrees.",
                  },
                }
              : {}),
            ...(settled.state === "unverified"
              ? {
                  pushSkipped:
                    "Could not read origin's main, so nothing was pushed. Commits made by this command stay in the sandbox until a later call can check them.",
                }
              : {}),
            ...(stdout.truncated || stderr.truncated
              ? {
                  outputCapped: {
                    stdoutOmittedChars: stdout.omittedChars,
                    stderrOmittedChars: stderr.omittedChars,
                    ...(fullOutputPath ? { fullOutputPath } : {}),
                    note: fullOutputPath
                      ? `Output was truncated. Full output saved to ${fullOutputPath}: grep, tail or sed -n it with sandbox_bash instead of re-running the command.`
                      : "Output was truncated and could not be saved. Re-run with output narrowed (| tail, | grep, > file).",
                  },
                }
              : {}),
          };
        } catch (error) {
          logger.warn("sandbox_bash failed", {
            workspaceId,
            userId,
            command: loggedCommand,
            error: redactSandboxSecrets(
              error instanceof Error ? error.message : String(error),
            ),
            durationMs: Date.now() - started,
          });
          return failure(error);
        }
      },
    }),

    sandbox_read_file: tool({
      description: `Read a file of your workspace sandbox's working copy (uncommitted edits included), by its path from the repo root, e.g. dbt/dbt_project.yml. Line-numbered; up to ${READ_DEFAULT_LIMIT_LINES} lines or ~${READ_MAX_CHARS / 1000}k chars per call, with nextOffset when more remains. Returns the file's hash for sandbox_write_file. Another member's private app reads as not found. Boots the sandbox when it is paused; repo_read_file reads main without it.`,
      inputSchema: z.object({
        path: z.string().min(1).describe("Path from the repo root"),
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
          .describe(`Lines to return (default ${READ_DEFAULT_LIMIT_LINES})`),
      }),
      execute: async ({ path, offset, limit }) => {
        try {
          const opened = await openOwnBox();
          if ("error" in opened) return { success: false, error: opened.error };
          const refused = refusePath(opened.view, path);
          if (refused) return { success: false, error: refused };
          const contents = await readSessionFile(opened.handle, path);
          const page = pageLines(contents, { offset, limit });
          // A file whose credentials were redacted on the way out cannot be
          // written back whole: the write would save the [REDACTED] markers.
          // Its hash says so, and sandbox_write_file refuses it.
          const redacted = redactSandboxSecrets(contents) !== contents;
          return {
            success: true,
            path,
            hash: redacted
              ? `${REDACTED_HASH_PREFIX}${contentHash(contents)}`
              : contentHash(contents),
            ...(redacted
              ? {
                  redacted: true,
                  note: "Credentials in this file were redacted. sandbox_write_file refuses to replace it; change it in place with sed in sandbox_bash.",
                }
              : {}),
            contents: redactSandboxSecrets(
              page.lines
                .map(
                  (line, i) =>
                    `${String(page.startLine + i).padStart(5)}│${line}`,
                )
                .join("\n"),
            ),
            startLine: page.startLine,
            endLine: page.endLine,
            totalLines: page.totalLines,
            ...(page.nextOffset !== undefined
              ? { nextOffset: page.nextOffset }
              : {}),
          };
        } catch (error) {
          return failure(error);
        }
      },
    }),

    sandbox_write_file: tool({
      description:
        "Create or replace a file of your workspace sandbox's working copy, by its path from the repo root. Each call needs the user's confirmation: in Mako's chat an approval card, over MCP your client's own tool approval. The write stays uncommitted: commit it with git in sandbox_bash (a commit on main moves to a sandbox/ branch). To replace an existing file pass the `hash` sandbox_read_file answered as expectedHash; the write is refused if the file changed since. Files git ignores (.env, node_modules/), anything under .git and another member's private app are refused.",
      needsApproval: true,
      inputSchema: z.object({
        path: z.string().min(1).describe("Path from the repo root"),
        contents: z.string(),
        expectedHash: z
          .string()
          .optional()
          .describe("The hash from your sandbox_read_file of this file"),
      }),
      execute: async ({ path, contents, expectedHash }) => {
        try {
          const opened = await openOwnBox();
          if ("error" in opened) return { success: false, error: opened.error };
          const { handle, view } = opened;
          const refused = refusePath(view, path);
          if (refused) return { success: false, error: refused };
          if (expectedHash?.startsWith(REDACTED_HASH_PREFIX)) {
            return {
              success: false,
              error: `${path} holds credentials that sandbox_read_file redacted, so writing it back whole would replace them with [REDACTED]. Change it in place with sed in sandbox_bash.`,
            };
          }
          let existing: string | undefined;
          try {
            existing = await readSessionFile(handle, path);
          } catch {
            existing = undefined;
          }
          if (
            existing !== undefined &&
            contentHash(existing) !== expectedHash
          ) {
            return {
              success: false,
              error:
                expectedHash === undefined
                  ? `${path} already exists. Read it with sandbox_read_file and pass its hash as expectedHash, so a change made since is not lost.`
                  : `${path} changed since you read it. Read it again and redo your change on what is there now.`,
            };
          }
          await writeFile(handle, path, contents);
          logger.info("sandbox_write_file", {
            workspaceId,
            userId,
            branch: handle.doc.branch,
            path,
            bytes: Buffer.byteLength(contents, "utf8"),
            created: existing === undefined,
          });
          return { success: true, path, hash: contentHash(contents) };
        } catch (error) {
          return failure(error);
        }
      },
    }),
  };
}

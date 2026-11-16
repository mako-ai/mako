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
 * an app lens). What these tools add is the repo root as the place to start,
 * so `dbt parse`, a script under scripts/ or `git status` across the repo
 * need no app id to borrow.
 *
 * What they add on top of app_bash, on purpose:
 * - A commit a command leaves on main is not pushed to main. It goes to a
 *   new `sandbox/<handle>/<stamp>` branch and the checkout's main is reset to
 *   origin's. Main moves only through the merge tools (app_merge_to_main,
 *   workflow_merge_to_main) or a push the command makes itself (see the
 *   security note in the PR: the box holds a git token, so a shell can).
 * - Mako credentials (`mgt_` git tokens, `revops_` API keys, basic-auth
 *   URLs) are redacted from every output and from the log line.
 * - Each command is logged: who, where, which branch, exit code, time.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { hasMinimumWorkspaceRole } from "@mako/agent-tools";

import { boxPushIfAhead } from "../../apps/box";
import { redactGitSecrets } from "../../apps/git";
import { DEFAULT_BRANCH } from "../../apps/repository.service";
import { getSandboxProvider } from "../../apps/sandbox/provider";
import { handleForUser } from "../../apps/user-handles.service";
import {
  boxCtx,
  ensureBox,
  ensureWorkspaceWorktree,
  execInWorktree,
  readSessionFile,
  writeFile,
  writeWorktreeScratchFile,
  type WorktreeHandle,
} from "../../apps/worktree.service";
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

const logger = loggers.agent();

/** The longest command text kept in the log line. */
const LOGGED_COMMAND_CHARS = 2_000;
/** Marks the hash of a read whose text was redacted: never writable back. */
const REDACTED_HASH_PREFIX = "redacted-";
/** Changed files listed by sandbox_status. */
const STATUS_MAX_CHANGES = 200;

/**
 * Mako's own credentials as they can show up in a box: the git token file
 * (`mgt_`), a workflow run's API key (`revops_`, in a sandbox run's env), and
 * whatever git prints with a token in it.
 */
export function redactSandboxSecrets(text: string): string {
  return redactGitSecrets(text)
    .replace(/\bmgt_[A-Za-z0-9._~+/=-]{8,}/g, "mgt_[REDACTED]")
    .replace(/\brevops_[A-Za-z0-9_-]{16,}/g, "revops_[REDACTED]");
}

const failure = (error: unknown) => ({
  success: false as const,
  error: redactSandboxSecrets(
    error instanceof Error ? error.message : String(error),
  ),
});

/** `sandbox/<handle>/<UTC stamp>`: where a commit made on main is moved. */
export function sandboxBranchName(owner: string, now = new Date()): string {
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
 * Runs after every command, in the repo root. When the checkout is on main
 * and holds commits origin's main does not, they go to `branch` (pushed),
 * and main goes back to origin's: `--keep` keeps uncommitted edits, `--soft`
 * is the fallback when they touch the same files (the commits' changes then
 * stay as uncommitted edits; they are safe on the branch either way).
 * Prints `MOVED <count> <keep|soft> <pushed 0|1>` when it moved anything.
 */
export function settleMainScript(branch: string): string {
  const main = DEFAULT_BRANCH;
  return [
    `b=$(git symbolic-ref --short -q HEAD || true)`,
    `if [ "$b" = "${main}" ] && git rev-parse -q --verify refs/remotes/origin/${main} >/dev/null; then`,
    `  n=$(git rev-list --count refs/remotes/origin/${main}..HEAD)`,
    `  if [ "$n" -gt 0 ]; then`,
    `    git branch -f '${branch}' HEAD`,
    `    if git push -q -u origin '${branch}' >/dev/null 2>&1; then p=1; else p=0; fi`,
    `    if git reset -q --keep refs/remotes/origin/${main} 2>/dev/null; then m=keep; else git reset -q --soft refs/remotes/origin/${main}; m=soft; fi`,
    `    echo "MOVED $n $m $p"`,
    `  fi`,
    `fi`,
  ].join("\n");
}

export function createSandboxTools({
  workspaceId,
  userId,
}: {
  workspaceId: string;
  userId?: string;
}): ToolSet {
  /**
   * The caller's own box, or why not. A person only: an API key with no
   * person behind it would share one box with every other such key. The
   * role is read live: a key outlives the membership that justified it.
   */
  const openOwnBox = async (): Promise<
    { handle: WorktreeHandle } | { error: string }
  > => {
    if (!userId) {
      return { error: "The sandbox belongs to a person; this call has none." };
    }
    const member = await workspaceService.getMember(workspaceId, userId);
    if (!hasMinimumWorkspaceRole(member?.role, "member")) {
      return {
        error: `The sandbox needs at least the member role (you are ${member?.role ?? "not a member"}).`,
      };
    }
    return { handle: await ensureWorkspaceWorktree(workspaceId, userId) };
  };

  const branchForMovedCommits = async () =>
    sandboxBranchName(
      (await handleForUser(workspaceId, userId).catch(() => undefined)) ??
        userId ??
        "user",
    );

  return {
    sandbox_status: tool({
      description:
        "Show your workspace sandbox: whether it is running, the branch its checkout is on, its root path, commits ahead of and behind origin, the uncommitted files across the whole repo, and which of node, python3, dbt, uv and bq it has. Pass start: true to boot it (sandbox_bash boots it too). One sandbox per person and workspace, shared with your app_bash, workflow_bash and the Mako terminal; it pauses after 10 idle minutes and keeps its files.",
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
          const { handle } = opened;
          const provider = getSandboxProvider();
          if (start) await ensureBox(handle);
          const ctx = boxCtx(handle);
          if (!(await provider.hasSession(ctx))) {
            return {
              success: true,
              running: false,
              branch: handle.doc.branch,
              note: "Not running. sandbox_status({ start: true }) or any sandbox_bash call boots it.",
            };
          }
          const result = await execInWorktree(
            handle,
            [
              "echo BRANCH $(git symbolic-ref --short -q HEAD || echo HEAD)",
              "echo HEAD $(git rev-parse --short HEAD)",
              "echo COUNTS $(git rev-list --left-right --count @{u}...HEAD 2>/dev/null || echo '- -')",
              "for t in node python3 dbt uv bq; do echo TOOL $t $(command -v $t >/dev/null && echo 1 || echo 0); done",
              `git status --porcelain=v1 | head -n ${STATUS_MAX_CHANGES + 1} | sed 's/^/CHANGE /'`,
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
            .map(line => line.slice("CHANGE ".length));
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
            changes: changes.slice(0, STATUS_MAX_CHANGES),
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
      description:
        "Run one bash command in your workspace sandbox (an E2B Linux VM with a clone of the whole workspace repo), starting at the repo root; `cwd` is relative to it. Use it for what spans the repo: git status/log/diff, scripts under scripts/, python3 or node one-offs, `pip install --user` then dbt parse. The checkout is the one your app_bash, workflow_bash and the Mako terminal share: dirty files you did not make are someone's in-flight work, leave them. Commits stay off main: a commit left on main is moved to a new sandbox/<you>/<time> branch (pushed) and main goes back to origin's; the result names the branch. Ship through app_merge_to_main or workflow_merge_to_main, never `git push` to main. Output is capped (start and end kept, the full text saved to a file in the sandbox) and Mako credentials in it are redacted. Default timeout 120 s, at most 600 s. Each call is logged.",
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
          .max(600)
          .optional()
          .describe("Kill the command after this many seconds (default 120)"),
      }),
      execute: async ({ command, cwd, timeoutSeconds }, { toolCallId }) => {
        const started = Date.now();
        let handle: WorktreeHandle | undefined;
        try {
          if (cwd && (cwd.startsWith("/") || cwd.split("/").includes(".."))) {
            return {
              success: false,
              error: `cwd must be a path inside the repo, relative to its root: ${cwd}`,
            };
          }
          const opened = await openOwnBox();
          if ("error" in opened) return { success: false, error: opened.error };
          handle = opened.handle;
          const result = await execInWorktree(handle, command, {
            cwd,
            timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
            pushIfAhead: false,
          });

          // Where the command left the checkout: never ahead of main.
          const branch = await branchForMovedCommits();
          const settled = await execInWorktree(
            handle,
            settleMainScript(branch),
            { timeoutMs: 180_000, pushIfAhead: false },
          );
          const moved = /MOVED (\d+) (keep|soft) ([01])/.exec(settled.stdout);
          if (!moved) {
            // On another branch: commits there are the session's own work,
            // pushed as app_bash pushes them, so a recycled box loses none.
            await boxPushIfAhead(boxCtx(handle)).catch(error =>
              logger.warn("sandbox_bash could not push the session branch", {
                error: error instanceof Error ? error.message : String(error),
              }),
            );
          }

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
            command: redactSandboxSecrets(command).slice(
              0,
              LOGGED_COMMAND_CHARS,
            ),
            exitCode: result.exitCode,
            timedOut: result.timedOut,
            durationMs: Date.now() - started,
            ...(moved ? { movedOffMain: Number(moved[1]), to: branch } : {}),
          });

          return {
            success: result.exitCode === 0,
            exitCode: result.exitCode,
            stdout: stdout.text,
            stderr: stderr.text,
            timedOut: result.timedOut,
            truncated: result.truncated,
            durationMs: result.durationMs,
            ...(moved
              ? {
                  movedOffMain: {
                    commits: Number(moved[1]),
                    branch,
                    pushed: moved[3] === "1",
                    note:
                      `The command committed on ${DEFAULT_BRANCH}. Those ${moved[1]} commit(s) are on ${branch}` +
                      (moved[3] === "1"
                        ? " (pushed)"
                        : " (NOT pushed: they exist only in this sandbox; push the branch)") +
                      `, and ${DEFAULT_BRANCH} is back to origin's` +
                      (moved[2] === "soft"
                        ? "; their changes also stay in the checkout as uncommitted edits."
                        : ".") +
                      ` Merge with app_merge_to_main or workflow_merge_to_main when the user agrees.`,
                  },
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
            command: redactSandboxSecrets(command).slice(
              0,
              LOGGED_COMMAND_CHARS,
            ),
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
      description: `Read a file of your workspace sandbox's working copy (uncommitted edits included), by its path from the repo root, e.g. dbt/dbt_project.yml. Line-numbered; up to ${READ_DEFAULT_LIMIT_LINES} lines or ~${READ_MAX_CHARS / 1000}k chars per call, with nextOffset when more remains. Returns the file's hash for sandbox_write_file. Boots the sandbox when it is paused; repo_read_file reads main without it.`,
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
        "Create or replace a file of your workspace sandbox's working copy, by its path from the repo root. The write stays uncommitted: commit it with git in sandbox_bash (a commit on main is moved to a sandbox/ branch). To replace an existing file pass the `hash` sandbox_read_file answered as expectedHash; the write is refused if the file changed since. Files git ignores and anything under .git are refused.",
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
          const { handle } = opened;
          let existing: string | undefined;
          try {
            existing = await readSessionFile(handle, path);
          } catch {
            existing = undefined;
          }
          if (expectedHash?.startsWith(REDACTED_HASH_PREFIX)) {
            return {
              success: false,
              error: `${path} holds credentials that sandbox_read_file redacted, so writing it back whole would replace them with [REDACTED]. Change it in place with sed in sandbox_bash.`,
            };
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

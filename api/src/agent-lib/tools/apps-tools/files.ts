/**
 * The shell and the file system: app_bash, app_read_file, app_glob,
 * app_grep, app_write_file, app_edit_file.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import { applyStrReplace, buildStrReplaceDiff } from "@mako/agent-tools";
import {
  BASH_STDERR_HEAD_CHARS,
  BASH_STDERR_MAX_CHARS,
  BASH_STDOUT_HEAD_CHARS,
  BASH_STDOUT_MAX_CHARS,
  GREP_MAX_LINE_CHARS,
  GREP_MAX_MATCHES,
  READ_DEFAULT_LIMIT_LINES,
  READ_MAX_CHARS,
  READ_MAX_LINE_CHARS,
  capLine,
  capText,
  pageLines,
} from "../shared/output-cap";
import {
  execInWorktree,
  globFiles,
  grepFiles,
  readFile,
  readSessionFile,
  writeFile,
  writeWorktreeScratchFile,
} from "../../../apps/worktree.service";
import {
  type AppsToolContext,
  logger,
  FULL_OUTPUT_FILES_KEPT,
  safeFileStem,
  contentHash,
  targetInputFor,
} from "./context";

export function appFileTools(ctx: AppsToolContext): ToolSet {
  const {
    kind,
    targetInput,
    actorId,
    ensureActorWorktree,
    markTouched,
    markRead,
    wasRead,
    workflowFolders,
    loadTarget,
    toRelPath,
    errorMessage,
  } = ctx;
  return {
    app_bash: tool({
      description:
        "Run a bash command in the app's sandbox session. cwd is the APP's folder (apps/<slug>) inside the workspace repo, not the repo root, so package.json and src/ are right here and `cwd` is interpreted relative to it. Use for anything a developer would do in a terminal: ls, grep, sed, cat, node, npm/pnpm install, npm run build, git status/log/diff. Each call is a one-shot command: backgrounding a long-running process (`vite &`) does NOT leave a server running the user can reach — use the app's preview controls for that. Git is fully yours: commit with app_commit or run git yourself — branch, checkout, merge, push; the sandbox is a real clone with a real remote. Note the checkout is SHARED with the user AND their other concurrent chats: a branch switch changes what everyone sees (do it when the task calls for it, and say so), and dirty files or 'Mako Agent' commits you don't recognize are someone else's in-flight work — normal, not corruption; leave them alone. Your end-of-turn auto-commit only includes apps YOU touched this turn. Output is capped (start + end kept); when it is cut, the full output is saved to a file in the sandbox whose path is returned — grep/tail/sed that file instead of re-running the command. Pipe noisy commands (installs, builds) through `| tail -n 50` or `| grep` up front.",
      inputSchema: z.object({
        ...targetInputFor(kind),
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
      execute: async (
        { appId, workflowId, command, cwd, timeoutSeconds },
        { toolCallId },
      ) => {
        const loaded = await loadTarget({ appId, workflowId }, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const handle = await ensureActorWorktree(loaded.project);
          markTouched(loaded.project);
          const result = await execInWorktree(handle, command, {
            cwd,
            timeoutMs: timeoutSeconds ? timeoutSeconds * 1000 : undefined,
          });
          const stdout = capText(result.stdout, {
            maxChars: BASH_STDOUT_MAX_CHARS,
            headChars: BASH_STDOUT_HEAD_CHARS,
          });
          const stderr = capText(result.stderr, {
            maxChars: BASH_STDERR_MAX_CHARS,
            headChars: BASH_STDERR_HEAD_CHARS,
          });
          let fullOutputPath: string | undefined;
          if (stdout.truncated || stderr.truncated) {
            try {
              fullOutputPath = await writeWorktreeScratchFile(
                handle,
                `mako-tool-output/${safeFileStem(toolCallId)}.log`,
                `$ ${command}\n\n=== stdout ===\n${result.stdout}\n\n=== stderr ===\n${result.stderr}\n`,
                { keepNewest: FULL_OUTPUT_FILES_KEPT },
              );
            } catch (error) {
              logger.warn("Could not save full app_bash output", {
                error: errorMessage(error),
                appId,
              });
            }
          }
          return {
            success: result.exitCode === 0,
            exitCode: result.exitCode,
            stdout: stdout.text,
            stderr: stderr.text,
            timedOut: result.timedOut,
            truncated: result.truncated,
            durationMs: result.durationMs,
            ...(stdout.truncated || stderr.truncated
              ? {
                  outputCapped: {
                    stdoutOmittedChars: stdout.omittedChars,
                    stderrOmittedChars: stderr.omittedChars,
                    ...(fullOutputPath ? { fullOutputPath } : {}),
                    note: fullOutputPath
                      ? `Output was truncated. Full output saved to ${fullOutputPath} — use grep, tail or sed -n on it via app_bash instead of re-running the command. The file is lost if the sandbox restarts.`
                      : "Output was truncated and could not be saved. Re-run with output narrowed (| tail, | grep, > file) to see the part that was cut.",
                  },
                }
              : {}),
          };
        } catch (error) {
          logger.error("app_bash failed", { error, appId });
          const message = errorMessage(error);
          // The shell starts in the workflow's folder, which a new or deleted
          // workflow does not have.
          const noFolder =
            workflowFolders.has(loaded.project) &&
            /cwd '.*' does not exist/i.test(message);
          return {
            success: false,
            error: noFolder
              ? `Workflow "${workflowId}" has no folder: a new name gets one on its first workflow_write_file, and a deleted one is gone. Pass a workflow that exists and cd from there.`
              : message,
          };
        }
      },
    }),

    app_read_file: tool({
      description: `Read a file from an Apps project at the latest durable state (committed + uncommitted). Prefer this over \`app_bash cat\` for single files. Returns line-numbered content by default so you can make precise anchored edits. Returns up to ${READ_DEFAULT_LIMIT_LINES} lines or ~${READ_MAX_CHARS / 1000}k chars per call (lines over ${READ_MAX_LINE_CHARS} chars are shortened); when more remains, the result has \`nextOffset\` — pass it as \`offset\` to continue, or use app_grep to find the part you need.`,
      inputSchema: z.object({
        ...targetInput,
        path: z
          .string()
          .min(1)
          .describe("Repo-relative path, e.g. src/App.tsx"),
        withLineNumbers: z
          .boolean()
          .optional()
          .describe("Prefix each line with its 1-based number (default true)"),
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
            `Maximum number of lines to return (default ${READ_DEFAULT_LIMIT_LINES}; the ~${READ_MAX_CHARS / 1000}k-char cap still applies)`,
          ),
      }),
      execute: async ({
        appId,
        workflowId,
        path: givenPath,
        withLineNumbers,
        offset,
        limit,
      }) => {
        const loaded = await loadTarget(
          { appId, workflowId },
          { write: false },
        );
        if ("error" in loaded) return { success: false, error: loaded.error };
        const relPath = toRelPath(loaded.project, givenPath);
        try {
          const file = await readFile(loaded.project, relPath, actorId);
          if (file.isBinary) {
            return {
              success: false,
              error: `${relPath} is binary (${file.size} bytes)`,
            };
          }
          markRead(loaded.project, file.path);
          const numbered = withLineNumbers !== false;
          const page = pageLines(file.contents, { offset, limit });
          const contents = numbered
            ? page.lines
                .map(
                  (l, i) =>
                    `${String(page.startLine + i).padStart(5)}\u2502${l}`,
                )
                .join("\n")
            : page.lines.join("\n");
          const partial =
            page.nextOffset !== undefined ||
            page.startLine > 1 ||
            page.longLinesCut > 0;
          return {
            success: true,
            path: file.path,
            // Of the whole file, whatever part was shown.
            hash: contentHash(file.contents),
            contents,
            lineNumbered: numbered,
            ...(partial
              ? {
                  startLine: page.startLine,
                  endLine: page.endLine,
                  totalLines: page.totalLines,
                  ...(page.nextOffset !== undefined
                    ? { nextOffset: page.nextOffset }
                    : {}),
                  ...(page.longLinesCut > 0
                    ? { longLinesCut: page.longLinesCut }
                    : {}),
                  note:
                    page.nextOffset !== undefined
                      ? `Showing lines ${page.startLine}-${page.endLine} of ${page.totalLines}. Pass offset: ${page.nextOffset} to continue, or app_grep for a specific part.`
                      : `Showing lines ${page.startLine}-${page.endLine} of ${page.totalLines}.`,
                }
              : {}),
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
        ...targetInput,
        pattern: z.string().min(1).describe("Glob, e.g. src/**/*.ts"),
      }),
      execute: async ({ appId, workflowId, pattern }) => {
        const loaded = await loadTarget(
          { appId, workflowId },
          { write: false },
        );
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
        ...targetInput,
        pattern: z.string().min(1).describe("Extended-regex pattern"),
        ignoreCase: z.boolean().optional(),
        pathspec: z
          .string()
          .optional()
          .describe("Limit to a path glob, e.g. 'src/'"),
      }),
      execute: async ({ appId, workflowId, pattern, ignoreCase, pathspec }) => {
        const loaded = await loadTarget(
          { appId, workflowId },
          { write: false },
        );
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          // One extra match tells us whether the cap cut anything.
          const found = await grepFiles(loaded.project, pattern, actorId, {
            ignoreCase,
            pathspec,
            maxMatches: GREP_MAX_MATCHES + 1,
          });
          const truncated = found.length > GREP_MAX_MATCHES;
          const matches = found
            .slice(0, GREP_MAX_MATCHES)
            .map(m => ({ ...m, text: capLine(m.text, GREP_MAX_LINE_CHARS) }));
          return {
            success: true,
            count: matches.length,
            matches,
            ...(truncated
              ? {
                  truncated: true,
                  note: `Stopped at ${GREP_MAX_MATCHES} matches. Narrow the pattern or pass a pathspec to see the rest.`,
                }
              : {}),
          };
        } catch (error) {
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app_write_file: tool({
      description:
        "Create or fully overwrite a file in an Apps project's working copy. Uncommitted until you commit, like any checkout. To replace an existing file, read it first (any part counts) and pass the `hash` app_read_file answered as `expectedHash`: the write is refused if the file changed since. For surgical edits prefer app_edit_file.",
      inputSchema: z.object({
        ...targetInput,
        path: z.string().min(1),
        contents: z.string(),
        expectedHash: z
          .string()
          .optional()
          .describe(
            "The `hash` from your read of this file (or from your last write or edit of it)",
          ),
        overwrite: z
          .boolean()
          .optional()
          .describe(
            "Replace an existing binary file, which read_file cannot read",
          ),
      }),
      execute: async ({
        appId,
        workflowId,
        path: givenPath,
        contents,
        expectedHash,
        overwrite,
      }) => {
        const loaded = await loadTarget({ appId, workflowId }, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        const relPath = toRelPath(loaded.project, givenPath);
        try {
          // Read-before-overwrite guard (Claude Code hallmark): a full rewrite
          // of an EXISTING file it hasn't read risks clobbering content
          // blindly, a teammate's edit included. Creating a new file is fine.
          // Anchored edits are exempt (they fail safely on a bad anchor). A
          // read of any part counts. Over MCP each call is its own exchange,
          // so nothing read earlier is remembered: the agent passes the
          // `hash` it read instead, which also catches a change since.
          if (expectedHash !== undefined || !wasRead(loaded.project, relPath)) {
            let existing: Awaited<ReturnType<typeof readFile>> | null = null;
            try {
              existing = await readFile(loaded.project, relPath, actorId);
            } catch {
              existing = null;
            }
            const current = existing && contentHash(existing.contents);
            if (existing && expectedHash !== undefined) {
              if (expectedHash !== current) {
                return {
                  success: false,
                  error: `${relPath} changed since you read it. Read it again with ${kind}_read_file and redo your change on what is there now.`,
                };
              }
            } else if (existing && !(overwrite && existing.isBinary)) {
              return {
                success: false,
                error: existing.isBinary
                  ? `${relPath} already exists and is binary. Pass overwrite: true to replace it.`
                  : `${relPath} already exists and was not read in this call. Read it first with ${kind}_read_file (any part counts) and pass the hash it answers as expectedHash, so a change made since is not lost; for a targeted change use ${kind}_edit_file. Do not delete it through ${kind}_bash.`,
              };
            }
          }
          const handle = await ensureActorWorktree(loaded.project);
          markTouched(loaded.project);
          await writeFile(handle, relPath, contents);
          markRead(loaded.project, relPath);
          return { success: true, path: relPath, hash: contentHash(contents) };
        } catch (error) {
          logger.error("app_write_file failed", { error, appId });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app_edit_file: tool({
      description:
        "Anchored string-replacement edit of a file in an Apps project (like str_replace). oldString must match exactly once unless replaceAll is set. Flushed to the durable WIP snapshot immediately.",
      // camelCase is canonical; the snake_case spellings are accepted too,
      // because agents used to Claude Code's Edit tool send `old_string`.
      inputSchema: z
        .object({
          ...targetInput,
          path: z.string().min(1),
          oldString: z.string().min(1).optional(),
          newString: z.string().optional(),
          replaceAll: z.boolean().optional(),
          old_string: z
            .string()
            .min(1)
            .optional()
            .describe("Alias of oldString."),
          new_string: z.string().optional().describe("Alias of newString."),
          replace_all: z.boolean().optional().describe("Alias of replaceAll."),
        })
        .superRefine((input, ctx) => {
          if (input.oldString === undefined && input.old_string === undefined) {
            ctx.addIssue({
              code: "custom",
              path: ["oldString"],
              message:
                "oldString is required: the exact text to replace (old_string is accepted too)",
            });
          }
          if (input.newString === undefined && input.new_string === undefined) {
            ctx.addIssue({
              code: "custom",
              path: ["newString"],
              message:
                "newString is required: the replacement text (new_string is accepted too)",
            });
          }
        }),
      execute: async input => {
        const { appId, workflowId, path: givenPath } = input;
        const oldString = (input.oldString ?? input.old_string) as string;
        const newString = (input.newString ?? input.new_string) as string;
        const replaceAll = input.replaceAll ?? input.replace_all;
        const loaded = await loadTarget({ appId, workflowId }, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        const relPath = toRelPath(loaded.project, givenPath);
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
          markTouched(loaded.project);
          await writeFile(handle, relPath, result.contents);
          return {
            success: true,
            path: relPath,
            hash: contentHash(result.contents),
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
  };
}

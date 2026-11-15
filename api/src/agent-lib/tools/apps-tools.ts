/**
 * Apps agent tools (apps.md §4.6).
 *
 * Not feature-flagged: apps is always available. Agents and MCP clients can
 * drive Apps in any workspace.
 *
 * The "real filesystem + real shell" tool contract:
 *
 *   app_bash        — the workhorse: any shell command in the app's sandbox
 *                      session (grep, ls, sed, node, package managers, ...)
 *   app_read_file / app_write_file / app_edit_file
 *                    — fast paths that skip shell quoting pitfalls
 *   app_status / app_commit
 *                    — durable-worktree status and WIP→branch commit (CAS)
 *   app_list_apps / app_create_app / search_apps
 *
 * Everything executes server-side (headless-safe). The agent works the way a
 * developer does: it edits files in a checkout, runs commands in a shell, and
 * commits. The checkout is the sandbox, which is an ordinary clone with an
 * ordinary remote, so `git push` is what makes work durable — there is no
 * separate snapshot step and nothing to reconcile.
 *
 */
import { type ToolSet } from "ai";
import { appCatalogTools } from "./apps-tools/catalog";
import {
  createAppsToolContext,
  type AppsToolsOptions,
  type TargetKind,
} from "./apps-tools/context";
import { appDeployTools } from "./apps-tools/deploy";
import { appFileTools } from "./apps-tools/files";
import { appPreviewTools } from "./apps-tools/preview";
import { appRepoTools } from "./apps-tools/repo";

export type { AppsToolsOptions } from "./apps-tools/context";

/** The `workflow_*` tools: the app tool each one is, and what it says it does. */
const WORKFLOW_TOOLS: Record<string, string> = {
  bash: "Run a bash command in your sandbox. cwd is the workflow's folder (workflows/<workflowId>) inside the workspace repo. Use it for git (status, checkout, pull, push) and for looking around; run a workflow with workflows_run, not from here.",
  read_file:
    "Read a file of a workflow, uncommitted edits included. Paths are relative to the workflow's folder. Returns line-numbered content.",
  glob: "Find files of a workflow by glob pattern (e.g. `**/*.ts`).",
  grep: "Search a workflow's files with a regex. Returns path:line:text matches.",
  write_file:
    "Create or fully overwrite a file of a workflow in your checkout. Nothing is committed, at the end of the turn either, until workflow_commit. To replace an existing file, read it first (any part counts) and pass the `hash` workflow_read_file answered as `expectedHash`: the write is refused if the file changed since. For small edits prefer workflow_edit_file.",
  edit_file:
    "Anchored string-replacement edit of a workflow's file. oldString must match exactly once unless replaceAll is set.",
  status:
    "Show the checkout's git state for a workflow: branch, base commit, and changed files.",
  commit:
    "Commit this workflow's folder with a message. Nothing deploys: from main the commit goes to your preview branch for the workflow (workflow/<you>/<workflowId>: main plus the folder as it is in your checkout, replaced on each commit), and your checkout stays on main. On another branch, it commits onto that branch. The user reviews it; workflow_merge_to_main deploys it.",
  merge_to_main:
    "Merge a branch into main: the deploy. From main, `branch` defaults to your preview branch for this workflow. Call it only after the user has reviewed the change and said to deploy it; only workspace admins may put workflow changes on main.",
};

export function createAppsTools(options: AppsToolsOptions): ToolSet {
  // One implementation, two names: a workflow is a folder like an app is, so
  // each `workflow_*` tool is the app tool built to take a `workflowId`.
  const forWorkflows = buildTools(options, "workflow");
  return {
    ...buildTools(options, "app"),
    ...Object.fromEntries(
      Object.entries(WORKFLOW_TOOLS).map(([name, description]) => [
        `workflow_${name}`,
        { ...forWorkflows[`app_${name}`], description } as ToolSet[string],
      ]),
    ),
  };
}

/** Every app tool, in one ToolSet, for one target kind. */
function buildTools(options: AppsToolsOptions, kind: TargetKind): ToolSet {
  const ctx = createAppsToolContext(options, kind);
  return {
    ...appCatalogTools(ctx),
    ...appFileTools(ctx),
    ...appDeployTools(ctx),
    ...appPreviewTools(ctx),
    ...appRepoTools(ctx),
  };
}

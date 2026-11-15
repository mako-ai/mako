/**
 * Moving an app, branches and commits, and materializing bindings:
 * app_move_app, app_list_branches, app_merge_to_main, app_materialize,
 * app_commit.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  commitPathToBranch,
  commitWorktree,
  catchUpLiveBox,
  listBranches,
  mergeBranchToMain,
  scopeOf,
  appRootFor,
  folderTargetFromPath,
  moveProject,
} from "../../../apps/worktree.service";
import { parseAppRepoPath } from "../../../apps/app-paths";
import { loadOwnerDirectory } from "../../../apps/user-handles.service";
import { authorizeAppMove } from "../../../apps/app-authorization";
import { materializeAppBinding } from "../../../apps/bindings.service";
import { type AppsToolContext, logger } from "./context";

export function appRepoTools(ctx: AppsToolContext): ToolSet {
  const {
    workspaceId,
    userId,
    targetInput,
    actorId,
    ensureActorWorktree,
    markTouched,
    currentActorBranch,
    previewBranchFor,
    memberRole,
    loadProject,
    loadTarget,
    scopeFor,
    errorMessage,
  } = ctx;
  return {
    app_move_app: tool({
      description:
        "File an app in another folder of the workspace repo, or rename its folder — one commit on main moving the directory (`git mv`). The app keeps its id, so its deployment, sharing, env vars and everyone's favourites follow it and nothing is rebuilt. Workspace folders need an editing role; `users/<handle>/apps/…` is that person's own tree. Moving a personal app into apps/… shares it with the whole workspace: do it only when the user asks to share.",
      inputSchema: z.object({
        appId: z.string(),
        folder: z
          .string()
          .describe(
            'Destination folder: "apps", "apps/Sales/CH", or "users/<handle>/apps" (app_list_apps → personalFolder).',
          ),
        name: z
          .string()
          .optional()
          .describe("New folder name for the app itself (a rename)."),
      }),
      execute: async ({ appId, folder, name }) => {
        const loaded = await loadProject(appId, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const target = folderTargetFromPath(folder);
          const source = parseAppRepoPath(appRootFor(loaded.project));
          const denied = authorizeAppMove(
            source,
            target,
            userId,
            await memberRole(),
            await loadOwnerDirectory(workspaceId, { forUserId: userId }),
          );
          if (denied) return { success: false, error: denied };
          const moved = await moveProject(
            loaded.project,
            { ...target, slug: name },
            { userId },
          );
          return {
            success: true,
            ...moved,
            app: loaded.project._id.toString(),
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
          const branches = await listBranches(scopeOf(loaded.project));
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
        ...targetInput,
        branch: z
          .string()
          .optional()
          .describe("Branch to merge (defaults to the branch you are on)"),
      }),
      execute: async ({ appId, workflowId, branch }) => {
        const loaded = await loadTarget({ appId, workflowId }, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        const main = loaded.project.defaultBranch || "main";
        let target = branch ?? (await currentActorBranch(loaded.project));
        // From main, a workflow's own branch is its preview branch.
        if (workflowId && target === main && !branch) {
          target = await previewBranchFor(workflowId);
        }
        if (target === main) {
          return {
            success: false,
            error:
              "Already on the default branch - there is nothing to merge. Commit with app_commit instead.",
          };
        }
        try {
          const result = await mergeBranchToMain(
            scopeFor(loaded.project),
            target,
            undefined,
            userId,
          );
          // The merger's checkout still holds the merged edits uncommitted;
          // the pull drops those main now has, so it catches up.
          if (result.merged && workflowId) {
            await catchUpLiveBox(loaded.project, actorId);
          }
          return { success: result.merged, ...result, branch: target };
        } catch (error) {
          logger.error("app_merge_to_main failed", { error, appId });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app_materialize: tool({
      description:
        "Build (or rebuild) the parquet artifact for a data binding of an Apps project. Bindings are files: bindings/<name>.sql with '-- connection: <id>' front matter (see the apps skill). By default reads THIS conversation's branch (the sandbox), so it works before merging to main; a binding missing there is read from main. From a laptop checkout pass from: \"main\" to build the binding as pushed to main, without the sandbox. The build runs synchronously against the warehouse (read-only enforced) and the preview serves the result at __data/<name>.parquet.",
      inputSchema: z.object({
        appId: z.string(),
        name: z.string().describe("Binding name (= filename without .sql)"),
        from: z
          .enum(["branch", "main"])
          .optional()
          .describe(
            'Where to read bindings/<name>.sql: "branch" (default) = this conversation\'s sandbox/branch; "main" = the workspace repo\'s main in git, never the sandbox (use from a laptop checkout).',
          ),
      }),
      execute: async ({ appId, name, from }) => {
        const loaded = await loadProject(appId, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          if (from !== "main") {
            // Binding reads prefer a live sandbox. Make an existing checkout
            // see the latest pushed binding before resolving its file; this
            // never boots an idle sandbox.
            await catchUpLiveBox(loaded.project, actorId);
          }
          markTouched(loaded.project);
          const result = await materializeAppBinding(
            loaded.project,
            name,
            actorId,
            from === "main" ? { from: "main" } : {},
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
        "Commit THIS app's uncommitted work (scoped to its apps/<slug> folder — other apps' and other chats' in-flight files in the shared checkout are untouched) onto the current branch with a message. Note: apps you touched are auto-committed at the end of every turn anyway; use this for meaningful mid-turn checkpoints with a good message.",
      inputSchema: z.object({
        ...targetInput,
        message: z.string().min(1).describe("Commit message"),
      }),
      execute: async ({ appId, workflowId, message }) => {
        const loaded = await loadTarget({ appId, workflowId }, { write: true });
        if ("error" in loaded) return { success: false, error: loaded.error };
        try {
          const handle = await ensureActorWorktree(loaded.project);
          markTouched(loaded.project);
          // A workflow on main goes to its preview branch: a commit on main is
          // the deploy, and that is the person's to review and merge. The
          // checkout stays on main: it is shared by the UI and every chat.
          const main = loaded.project.defaultBranch || "main";
          if (workflowId && handle.doc.branch === main) {
            const branch = await previewBranchFor(workflowId);
            const result = await commitPathToBranch(
              handle,
              handle.appRoot,
              branch,
              { base: main, message },
            );
            return {
              success: result.committed,
              ...result,
              branch,
              ...(result.committed
                ? {
                    deployed: false,
                    next: `Not deployed: ${branch} is ${main} plus this workflow as it is in your checkout; your checkout stays on ${main}. Show the user what changed, and only on their go-ahead deploy it with workflow_merge_to_main (an admin's call). A later workflow_commit replaces the branch.`,
                  }
                : {}),
            };
          }
          // Scoped to THIS app's folder: the working copy is shared by every
          // chat this user runs, so an unscoped commit would sweep a
          // concurrent chat's in-flight work on another app in with it.
          const result = await commitWorktree(handle, message, undefined, {
            paths: [handle.appRoot],
          });
          return { success: result.committed, ...result };
        } catch (error) {
          logger.error("app_commit failed", { error, appId });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),
  };
}

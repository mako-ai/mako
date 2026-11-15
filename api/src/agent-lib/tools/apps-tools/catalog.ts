/**
 * Finding and creating apps: app_list_apps, search_apps, app_create_app.
 */
import { tool, type ToolSet } from "ai";
import { z } from "zod";
import {
  catchUpLiveBox,
  createProject,
  listFiles,
  appRootFor,
  folderTargetFromPath,
  listAppFolderPaths,
  type AppFolderTarget,
} from "../../../apps/worktree.service";
import { appTreeRoot } from "../../../apps/app-paths";
import { loadOwnerDirectory } from "../../../apps/user-handles.service";
import { loadAppsIndex } from "../../../apps/app-index.service";
import { rankApps } from "../../../apps/app-search";
import {
  appUsageScores,
  bindingTablesByApp,
  prefetchQueryEmbedding,
  relatedSignals,
} from "../../../apps/app-search.service";
import { authorizeFolderTarget } from "../../../apps/app-authorization";
import { type AppsToolContext, logger } from "./context";

export function appCatalogTools(ctx: AppsToolContext): ToolSet {
  const {
    workspaceId,
    userId,
    actorId,
    markTouched,
    memberRole,
    errorMessage,
    visibleApps,
    personalRoot,
  } = ctx;
  return {
    app_list_apps: tool({
      description:
        "List Apps (git-backed) projects in the workspace, the folders to file new ones in, and `personalFolder` — the caller's own tree (users/<handle>/apps), where new apps go by default.",
      inputSchema: z.object({}),
      execute: async () => {
        // The repo is the list: an app is a folder under apps/ (§13.6), so
        // one written straight into a checkout and pushed shows up here with
        // no registration step. listAppFolders freshens the mirror itself
        // (throttled), so list and open cannot disagree for more than a few
        // seconds merely because they landed on different API instances.
        const [apps, folderPaths, personalFolder] = await Promise.all([
          visibleApps(),
          listAppFolderPaths(workspaceId),
          personalRoot(),
        ]);
        return {
          success: true,
          apps: apps.map(({ folder: f }) => ({
            app: f.id,
            // The folder IS the app; its path is what to cd into.
            path: f.path,
            title: f.title,
            description: f.description,
            scope: f.scope,
          })),
          // Folders of the workspace tree and of the caller's personal tree,
          // for filing new apps (app_create_app `folder`, app_move_app).
          folders: folderPaths.filter(
            p =>
              p.startsWith("apps/") ||
              (!!personalFolder &&
                (p === personalFolder || p.startsWith(`${personalFolder}/`))),
          ),
          ...(personalFolder ? { personalFolder } : {}),
        };
      },
    }),

    search_apps: tool({
      description:
        'Search the workspace\'s existing apps by what they do: free text over title, description (mako.json), path, owner and the warehouse tables their bindings read, plus semantically related apps (matchedOn: ["related"], after the word matches). Returns the best matches the caller can see, ranked by relevance (and usage, where tracked). Call this BEFORE app_create_app: if a close match exists, propose extending or reusing it instead of building a near-copy.',
      inputSchema: z.object({
        query: z
          .string()
          .min(1)
          .describe(
            'What the app is about, e.g. "leads by canton", "agent quotas", or a table name like "close_leads".',
          ),
        limit: z
          .number()
          .int()
          .positive()
          .max(25)
          .optional()
          .describe("Maximum results (default 10)."),
      }),
      execute: async ({ query, limit }) => {
        try {
          prefetchQueryEmbedding(query);
          const [apps, snapshot, directory, usage] = await Promise.all([
            visibleApps(),
            loadAppsIndex(workspaceId),
            loadOwnerDirectory(workspaceId),
            appUsageScores(workspaceId),
          ]);
          const tables = bindingTablesByApp(snapshot);
          const related = await relatedSignals(
            workspaceId,
            query,
            apps.map(({ folder: f }) => f.id),
          );
          const results = rankApps(
            apps.map(({ folder: f, state }) => ({
              appId: f.id,
              path: f.path,
              title: f.title,
              description: f.description,
              owner: directory.handleOf(
                f.scope === "private" ? f.ownerId : state?.owner_id,
              ),
              tables: tables.get(f.path) ?? [],
              usageScore: usage?.get(f.id),
            })),
            query,
            { limit, related },
          );
          return {
            success: true,
            results: results.map(r => ({
              app: r.appId,
              title: r.title,
              description: r.description,
              path: r.path,
              owner: r.owner,
              tables: r.tables,
              score: r.score,
              matchedOn: r.matchedOn,
              ...(r.usageScore !== undefined
                ? { usageScore: r.usageScore }
                : {}),
            })),
            ...(usage === null
              ? {
                  note: "Usage is unavailable right now; ranked by relevance only.",
                }
              : {}),
          };
        } catch (error) {
          logger.error("search_apps failed", { error });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),

    app_create_app: tool({
      description:
        "Create a new app: a real Vite + React + TypeScript project scaffolded into a folder of the workspace repo. By DEFAULT it goes into the user's personal tree (users/<handle>/apps/<name>/, private to them) — pass `folder` under apps/… only when the user explicitly asks for a shared/workspace app; sharing is a deliberate later step (app_move_app). Call search_apps first and offer to extend a close match. The FOLDER is the app — creating one is just committing that directory, and you can equally create it yourself with app_bash + app_write_file (give its mako.json an `id`). Returns the app id and path that every other app_* tool takes.",
      inputSchema: z.object({
        title: z.string().min(1).describe("Human-readable app title"),
        description: z
          .string()
          .min(1)
          .describe(
            "One line: what the app measures, for whom, which markets. Shown under the title on the Apps home and read by search.",
          ),
        folder: z
          .string()
          .optional()
          .describe(
            'Destination folder. Omit for the personal tree (default, see app_list_apps → personalFolder) or name a subfolder of it ("users/<handle>/apps/Sales"); "apps" or "apps/Sales/CH" ONLY when the user asked for a shared workspace app.',
          ),
      }),
      execute: async ({ title, description, folder }) => {
        try {
          // Personal by default: a new app is the creator's own until they
          // share it. An actor with no person behind it (an API key without
          // a user) has no personal tree and keeps the workspace default.
          const directory = await loadOwnerDirectory(workspaceId, {
            forUserId: userId,
          });
          const handle = directory.handleOf(userId);
          const wanted =
            folder ?? (handle ? appTreeRoot("private", handle) : undefined);
          let target: AppFolderTarget | undefined;
          if (wanted) {
            target = folderTargetFromPath(wanted);
            // The same rules as the REST route (app-authorization.ts): an
            // actor with no role at all — an API key whose creator left —
            // is refused here exactly as it is there.
            const denied = authorizeFolderTarget(
              target,
              userId,
              await memberRole(),
              directory,
            );
            if (denied) return { success: false, error: denied };
          }
          const project = await createProject({
            workspaceId,
            title,
            description,
            userId,
            folder: target,
          });
          // The scaffold just landed on main server-side. If this actor's
          // sandbox is RUNNING, reads are served from it — and it has not
          // heard yet, so without a catch-up the brand-new app lists as
          // empty and the agent rebuilds the scaffold by hand over it.
          await catchUpLiveBox(project, actorId);
          markTouched(project);
          const { entries } = await listFiles(project, actorId);
          return {
            success: true,
            app: project._id.toString(),
            path: appRootFor(project),
            title: project.title,
            scope: target?.scope ?? "workspace",
            files: entries.map(e => e.path),
            note:
              (target?.scope === "private"
                ? "Created in the user's personal folder (private to them). Sharing it with the workspace is a separate, deliberate step (app_move_app into apps/…) when they ask. "
                : "") +
              "Real project: use app_bash for shell commands (ls, grep, npm install, npm run build, ...), app_write_file/app_edit_file for edits, app_commit to commit.",
          };
        } catch (error) {
          logger.error("app_create_app failed", { error });
          return { success: false, error: errorMessage(error) };
        }
      },
    }),
  };
}

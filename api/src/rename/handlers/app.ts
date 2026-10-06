/**
 * Graceful rename for apps (api/src/rename/types.ts).
 *
 * An app is a folder with a `mako.json` in the workspace repo; its id lives
 * in that manifest, its display name is the manifest's `title`, and its link
 * is `/apps/<slug>` for a top-level app (`/apps/<id>` for a nested or
 * personal one — see the client's `appUrlRef`). A rename here is ONE commit
 * on main through `renameProject`: a slug change is a move within the app's
 * own folder, which records the old slug as an alias in the manifest; a
 * title change rewrites the manifest. Resolution goes through the apps
 * index, where id → current path/slug → alias is the rule for every reader
 * (`findAppInSnapshotVia`), so an agent, a route and a link all agree.
 */
import { Types } from "mongoose";
import { AppProject } from "../../database/workspace-schema";
import {
  findAppInSnapshotVia,
  loadAppsIndex,
  resolveAppRef,
  type AppIndexRow,
} from "../../apps/app-index.service";
import {
  APPS_DIR,
  isSafeSegment,
  parseAppRepoPath,
} from "../../apps/app-paths";
import { authorizeAppMove } from "../../apps/app-authorization";
import { freshenForServe } from "../../apps/cloud-repo.service";
import {
  AppFolderError,
  appRootFor,
  projectFromIndexRow,
  renameProject,
  resolveProjectRef,
  type SupersededAlias,
} from "../../apps/worktree.service";
import { canReadResource, canWriteResource } from "../../utils/resource-acl";
import {
  RenameError,
  type RenameContext,
  type RenameHandler,
  type RenameLocation,
  type ResolvedRef,
} from "../types";

/**
 * The in-app link for an app, as the client builds it (`appUrlRef` in
 * app/src/store/appsStore.ts): the slug for a top-level app of the
 * workspace tree, the id for everything else — a nested folder name may be
 * shared by another app, an id never is.
 */
export function appUrlFor(app: Pick<AppIndexRow, "appId" | "path" | "slug">) {
  const ref = app.path === `${APPS_DIR}/${app.slug}` ? app.slug : app.appId;
  return `/apps/${encodeURIComponent(ref)}`;
}

function locationOf(app: AppIndexRow): RenameLocation {
  return {
    title: app.title,
    slug: app.slug,
    path: app.path,
    url: appUrlFor(app),
  };
}

/**
 * The ref as the index sees it, fetching the mirror once on a miss: a
 * rename pushed from a laptop a moment ago resolves here on the first try,
 * as every app_* tool's lookup does.
 */
async function findVia(
  workspaceId: string,
  ref: string,
): Promise<{ app: AppIndexRow; via: "current" | "alias" } | null> {
  let found = findAppInSnapshotVia(await loadAppsIndex(workspaceId), ref);
  if (!found) {
    await freshenForServe(workspaceId, 0).catch(() => undefined);
    found = findAppInSnapshotVia(
      await loadAppsIndex(workspaceId, { freshen: false }),
      ref,
    );
  }
  return found;
}

/**
 * What the caller must know when a name this rename keeps as an alias was
 * also another app's old name: the link now opens the renamed app, and the
 * other app no longer answers to it. The other app is named only when the
 * caller may see it.
 */
async function supersessionWarnings(
  ctx: RenameContext,
  newTitle: string,
  superseded: SupersededAlias[],
): Promise<string[]> {
  const warnings: string[] = [];
  for (const entry of superseded) {
    let other = "another app";
    if (!ctx.userId) {
      other = `"${entry.title}" (${entry.path})`;
    } else {
      const state = await AppProject.findOne({
        _id: new Types.ObjectId(entry.appId),
        workspaceId: new Types.ObjectId(ctx.workspaceId),
      });
      const row = await resolveAppRef(ctx.workspaceId, entry.appId);
      const resource =
        state ?? (row ? projectFromIndexRow(ctx.workspaceId, row) : null);
      if (resource && canReadResource(resource, ctx.userId, ctx.role)) {
        other = `"${entry.title}" (${entry.path})`;
      }
    }
    const link = entry.name.includes("/")
      ? entry.name
      : `/apps/${encodeURIComponent(entry.name)}`;
    warnings.push(
      `${link} now opens "${newTitle}"; it was also an old name of ${other}, which no longer answers to it` +
        (entry.manifestUpdated
          ? "."
          : " (its mako.json could not be parsed, so the name is still listed there; the index ignores it)."),
    );
  }
  return warnings;
}

export const appRenameHandler: RenameHandler = {
  kind: "app",
  describe:
    "`title` is the display name (mako.json `title`); `slug` is the app's folder name, which its /apps/<slug> link is made of — the old slug is kept as an alias in mako.json so old links and refs still open the app. `ref` accepts the id, the repo path, the slug, or an old slug. A slug change needs an editing role (a personal app: its owner).",

  async resolve(ctx, ref) {
    const found = await findVia(ctx.workspaceId, ref);
    if (!found) return null;
    // Never leak an app the caller cannot see: the same visibility rule
    // the list route applies (a restricted row, or a personal tree).
    if (ctx.userId) {
      const state = await AppProject.findOne({
        _id: new Types.ObjectId(found.app.appId),
        workspaceId: new Types.ObjectId(ctx.workspaceId),
      });
      const resource = state ?? projectFromIndexRow(ctx.workspaceId, found.app);
      if (!canReadResource(resource, ctx.userId, ctx.role)) return null;
    }
    const resolved: ResolvedRef = {
      kind: "app",
      id: found.app.appId,
      via: found.via,
      current: locationOf(found.app),
    };
    return resolved;
  },

  async rename(ctx, request) {
    const project = await resolveProjectRef(ctx.workspaceId, request.ref, {
      fetchOnMiss: true,
    });
    if (!project) throw new RenameError(`App ${request.ref} not found`, 404);
    // The same gate as every app write: a per-user ACL when there is a user
    // behind the call, none for a workspace API key (apps-tools' loadProject).
    if (ctx.userId && !canWriteResource(project, ctx.userId, ctx.role)) {
      throw new RenameError(`App ${request.ref} not found`, 404);
    }
    const from = appRootFor(project);
    const source = parseAppRepoPath(from);
    if (!source) throw new RenameError(`Not an app path: ${from}`, 404);
    const slug = request.slug?.trim();
    if (slug !== undefined && slug !== source.slug) {
      if (!isSafeSegment(slug)) {
        throw new RenameError(
          `Invalid app folder name: ${JSON.stringify(slug)}`,
        );
      }
      // A slug change moves the folder: the move rules apply, as they do
      // for app_move_app with `name`.
      const denied = authorizeAppMove(
        source,
        { ...source, folderSegments: [...source.folderSegments] },
        ctx.userId,
        ctx.role,
      );
      if (denied) throw new RenameError(denied, 403);
    }
    const before = await findVia(ctx.workspaceId, project._id.toString());
    try {
      const result = await renameProject(
        project,
        {
          ...(request.title !== undefined ? { title: request.title } : {}),
          ...(slug !== undefined ? { slug } : {}),
        },
        { userId: ctx.userId },
      );
      const after = await findVia(ctx.workspaceId, project._id.toString());
      const afterRow: AppIndexRow | undefined =
        after?.app ??
        (before
          ? {
              ...before.app,
              path: result.to,
              slug: result.to.split("/").pop() ?? before.app.slug,
              title: result.title,
            }
          : undefined);
      return {
        kind: "app",
        id: project._id.toString(),
        before: before
          ? locationOf(before.app)
          : { title: project.title, slug: source.slug, path: from },
        after: afterRow
          ? locationOf(afterRow)
          : { title: result.title, path: result.to },
        aliasesAdded: result.aliasesAdded,
        ...(result.commit ? { commit: result.commit } : {}),
        warnings: await supersessionWarnings(
          ctx,
          afterRow?.title ?? result.title,
          result.superseded,
        ),
      };
    } catch (error) {
      if (error instanceof AppFolderError) {
        throw new RenameError(error.message, error.status);
      }
      throw error;
    }
  },
};

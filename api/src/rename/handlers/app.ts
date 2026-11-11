/**
 * Renaming an app (api/src/rename/types.ts).
 *
 * An app is a folder with a `mako.json` in the workspace repo. Its id is in
 * that manifest, its display name is the manifest's `title`, and its link is
 * `/apps/<slug>` for a top-level app of the workspace tree (`/apps/<id>` for
 * a nested or personal one — the client's `appUrlRef`). A rename is ONE
 * commit on main through `renameProject`: a new slug moves the folder and
 * records the old slug in the manifest's `aliases`; a new title rewrites the
 * manifest. Resolution goes through the apps index, where id → current
 * path/slug → alias is the rule for every reader (`findAppInSnapshotVia`),
 * so an agent, a route and a link all agree.
 */
import { Types } from "mongoose";
import { AppProject } from "../../database/workspace-schema";
import {
  resolveAppRefVia,
  type AppIndexRow,
} from "../../apps/app-index.service";
import { APPS_DIR, isAppId, parseAppRepoPath } from "../../apps/app-paths";
import {
  appRenameRights,
  canSeeIndexedApp,
} from "../../apps/app-authorization";
import { loadOwnerDirectory } from "../../apps/user-handles.service";
import {
  AppFolderError,
  projectFromIndexRow,
  renameProject,
} from "../../apps/worktree.service";
import {
  RenameError,
  type RenameContext,
  type RenameHandler,
  type RenameLocation,
} from "../types";

/**
 * The in-app link of an app, as the client builds it (`appUrlRef` in
 * app/src/store/appsStore.ts): the slug for a top-level app of the
 * workspace tree, the id for everything else — a nested folder name may be
 * shared by another app, an id never is. A top-level folder whose name
 * reads as an id (pushed from a laptop; Mako never hands one out) is
 * addressed by its id too.
 */
export function appUrlFor(app: Pick<AppIndexRow, "appId" | "path" | "slug">) {
  const ref =
    app.path === `${APPS_DIR}/${app.slug}` && !isAppId(app.slug)
      ? app.slug
      : app.appId;
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
 * The app a ref names in THIS workspace, with its state row when it has
 * one — or null when there is none, or the caller may not see it (the app
 * list's rule: a restricted app, or one in someone else's personal folder,
 * must not be revealed by a guess at its name).
 */
async function find(ctx: RenameContext, ref: string) {
  const found = await resolveAppRefVia(ctx.workspaceId, ref, {
    fetchOnMiss: true,
  });
  if (!found) return null;
  const row = await AppProject.findOne({
    _id: new Types.ObjectId(found.app.appId),
    workspaceId: new Types.ObjectId(ctx.workspaceId),
  });
  if (!canSeeIndexedApp(found.app, row, ctx.userId, ctx.role)) return null;
  return { ...found, row };
}

export const appRenameHandler: RenameHandler = {
  kind: "app",
  describe:
    "`title` is the display name (mako.json `title`). `slug` is the app's folder name, which its /apps/<slug> link is made of; the old slug is kept in mako.json `aliases`, so old links and refs still open the app. `ref` is the id, the repo path, the slug, or an old slug. Changing the slug needs an editing role (in a personal folder: its owner).",

  async resolve(ctx, ref) {
    const found = await find(ctx, ref);
    if (!found) return null;
    return {
      kind: "app",
      id: found.app.appId,
      via: found.via,
      current: locationOf(found.app),
    };
  },

  async rename(ctx, request) {
    const found = await find(ctx, request.ref);
    const source = found ? parseAppRepoPath(found.app.path) : null;
    if (!found || !source) throw new RenameError("App not found.", 404);
    const project =
      found.row ?? projectFromIndexRow(ctx.workspaceId, found.app);
    // The index is the truth about where the app is; the row may lag.
    project.path = found.app.path;
    project.slug = found.app.slug;
    const rights = appRenameRights(
      project,
      source,
      ctx.userId,
      ctx.role,
      await loadOwnerDirectory(ctx.workspaceId, { forUserId: ctx.userId }),
    );
    if (rights.kind === "none") {
      throw rights.hidden
        ? new RenameError("App not found.", 404)
        : new RenameError(rights.reason, 403);
    }
    const slugChanges =
      request.slug !== undefined &&
      request.slug.trim().normalize("NFC") !== found.app.slug;
    if (slugChanges && rights.kind === "title") {
      throw new RenameError(rights.linkReason, 403);
    }
    try {
      const result = await renameProject(
        project,
        {
          ...(request.title !== undefined ? { title: request.title } : {}),
          ...(slugChanges ? { slug: request.slug } : {}),
        },
        { userId: ctx.userId },
      );
      const after: AppIndexRow = {
        ...found.app,
        path: result.to,
        slug: result.to.split("/").pop() ?? found.app.slug,
        title: result.title,
      };
      return {
        kind: "app",
        id: found.app.appId,
        before: locationOf(found.app),
        after: locationOf(after),
        aliasesAdded: result.aliasesAdded,
        ...(result.commit ? { commit: result.commit } : {}),
        warnings: [],
      };
    } catch (error) {
      if (error instanceof AppFolderError) {
        throw new RenameError(error.message, error.status);
      }
      throw error;
    }
  },
};

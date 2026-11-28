/**
 * The app list as one caller sees it (GET /apps), and the write check a
 * folder move needs over every app inside the folder.
 *
 * The REPO is the list. An app exists because a folder with a `mako.json`
 * exists (anywhere under apps/ or users/<handle>/apps/), so a folder pushed
 * from a local checkout shows up with no registration step (§13). Postgres is
 * consulted only for what cannot live in a repo the customer can clone:
 * visibility, the deployed sha, the share token — and the derived index that
 * makes this read one query.
 */
import type { IAppProject } from "../database/workspace-schema";
import { timed } from "../middleware/server-timing";
import {
  appsMetadataRepo,
  type AppProjectListShare,
  toAppProjectCompat,
} from "../repositories/apps-metadata";
import { canWriteResource } from "../utils/resource-acl";
import { loadAppsIndex } from "./app-index.service";
import { canSeeIndexedApp } from "./app-authorization";
import { verifiedAppIds } from "./app-lifecycle.service";
import { appTreeRoot } from "./app-paths";
import { loadOwnerDirectory } from "./user-handles.service";
import { ensureWorkspaceTemplateSoon } from "./workspace-template";
import { repoForWorkspace } from "./worktree.service";

export interface ListedApp {
  id: string;
  slug: string;
  path: string;
  scope: "workspace" | "private";
  title: string;
  description?: string;
  access: string;
  owner_id?: string;
  workspaceRole?: IAppProject["workspaceRole"];
  publicShare?: AppProjectListShare;
  publishedSha?: string;
  publishedAt?: Date;
  chatEnabled: boolean;
  duplicateOf?: string;
  verified: boolean;
  /** The app's `icon.*` and its blob oid (GET /apps/:id/icon?v=<oid>). */
  icon?: { file: string; oid: string };
}

export interface AppListing {
  apps: ListedApp[];
  /** Folders of the workspace tree and the caller's own personal tree. */
  folders: string[];
  /** Where the caller's own apps go: `users/<handle>/apps`. */
  personalRoot?: string;
}

export async function listVisibleApps(
  workspaceId: string,
  userId: string | undefined,
  role: string | undefined,
): Promise<AppListing> {
  // One index read for both (each used to fetch and rev-parse on its own).
  const snapshot = await timed("list.index", () => loadAppsIndex(workspaceId));
  const folders = snapshot.apps.map(app => ({ ...app, id: app.appId }));
  // Keep the repo's agent-facing template current for whoever is looking
  // at it (throttled, off the request path — see workspace-template.ts).
  repoForWorkspace(workspaceId)
    .then(repoDir => ensureWorkspaceTemplateSoon(workspaceId, repoDir))
    .catch(() => undefined);
  const [docs, verified] = await Promise.all([
    timed("list.projects", () =>
      appsMetadataRepo.listProjectListingStates(workspaceId),
    ),
    timed("list.verified", () => verifiedAppIds(workspaceId)),
  ]);
  const stateById = new Map(docs.map(d => [d.id, d]));

  const apps = folders
    // No record yet means nothing has restricted it — a folder someone
    // pushed is workspace content, visible like any other file in the
    // repo. A folder in someone's personal tree is theirs alone.
    .filter(folder =>
      canSeeIndexedApp(folder, stateById.get(folder.id), userId, role),
    )
    .map((folder): ListedApp => {
      const state = stateById.get(folder.id);
      return {
        id: folder.id,
        slug: folder.slug,
        path: folder.path,
        scope: folder.scope,
        title: folder.title,
        description: folder.description,
        access:
          state?.access ??
          (folder.scope === "private" ? "private" : "workspace"),
        // Who restricted it — the sidebar files a private app someone
        // else shared with you under "Shared with me", not "My Apps".
        owner_id:
          state?.owner_id ??
          (folder.scope === "private" ? folder.ownerId : undefined),
        workspaceRole: state?.workspaceRole,
        publicShare: state?.publicShare,
        publishedSha: state?.publishedSha,
        publishedAt: state?.publishedAt,
        chatEnabled: state?.chatEnabled === true,
        // A copied app that still declares its source's id: the index
        // filed it under its own derived id; the UI offers to stamp one.
        duplicateOf: folder.duplicateOf,
        // A workspace admin vouched for it (app-lifecycle.service.ts).
        verified: folder.scope === "workspace" && verified.has(folder.id),
        // Its favicon, for the explorer row; none = a generated letter mark.
        ...(folder.icon ? { icon: folder.icon } : {}),
      };
    });
  // Folders of the two trees the caller can see: the workspace tree, and
  // their own personal tree (never anyone else's) — by the handle
  // mapping, not by what the folder is called.
  const directory = await timed("list.directory", () =>
    loadOwnerDirectory(workspaceId, { forUserId: userId }),
  );
  const handle = directory.handleOf(userId);
  const personalRoot = handle ? appTreeRoot("private", handle) : undefined;
  const visibleFolders = snapshot.folders.filter(p => {
    if (p.startsWith("apps/")) return true;
    return (
      !!personalRoot && (p === personalRoot || p.startsWith(`${personalRoot}/`))
    );
  });
  return { apps, folders: visibleFolders, personalRoot };
}

/**
 * Moving a folder moves every app in it, and a move into a personal tree
 * re-owns them: the caller must be allowed to write each one, as moving a
 * single app requires. Returns the first app they may not write, if any.
 */
export async function firstUnwritableAppIn(
  workspaceId: string,
  folderPath: string,
  userId: string,
  role: string | undefined,
): Promise<IAppProject | undefined> {
  const fromPath = folderPath.replace(/\/+$/, "");
  const inside = (await loadAppsIndex(workspaceId)).apps.filter(
    a => a.path === fromPath || a.path.startsWith(`${fromPath}/`),
  );
  if (inside.length === 0) return undefined;
  const rows = (
    await appsMetadataRepo.listProjectsByIds(
      workspaceId,
      inside.map(a => a.appId),
    )
  ).map(r => toAppProjectCompat(r));
  return rows.find(row => !canWriteResource(row, userId, role));
}

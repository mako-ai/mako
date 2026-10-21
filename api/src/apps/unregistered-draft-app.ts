/**
 * The app a laptop is building before main has heard of it.
 *
 * `makoData()` addresses its app by the manifest `id`, or by the folder name
 * when the manifest has none. A brand-new app exists only in the developer's
 * checkout until it is pushed, so neither resolves (resolveProjectRef) and
 * every dev build answered 404 "App not found" — no data until a shell of the
 * app reached production, which is exactly what draft builds exist to avoid.
 *
 * A DRAFT build never touches the app's state: it is built from the text the
 * laptop sent, kept only under its own draft/job keys and never stored as the
 * app's artifact (binding-dev-build.ts). So it does not need a registered app,
 * only a stable key to file its drafts under. This module synthesizes that
 * key, and nothing else:
 *
 *   - id: the manifest id when the ref is one, else the id the index will
 *     derive for `apps/<slug>` once it is pushed without one (derivedAppId),
 *     so a draft built today is the draft the pushed app finds;
 *   - refused (null) whenever the ref could mean something that EXISTS: an
 *     app the index knows by that id, path or slug (in this workspace, even
 *     one the caller may not see — a 404 must stay a 404), a project row, or
 *     an id another workspace's index or rows already use;
 *   - private to the caller, so the usual ACL makes them its only reader.
 *
 * Who may build one is the caller's workspace role, not an app ACL (there is
 * no app yet): see `unregisteredDraftAccess`.
 */
import { Types } from "mongoose";
import {
  AppIndexEntry,
  AppProject,
  type IAppProject,
} from "../database/workspace-schema";
import {
  APPS_DIR,
  appKeyOf,
  derivedAppId,
  isAppId,
  parseAppRepoPath,
} from "./app-paths";
import { findAppInSnapshot, loadAppsIndex } from "./app-index.service";
import { DEFAULT_BRANCH } from "./repository.service";

/** What a ref names when nothing on main does. */
export interface UnregisteredDraftIdentity {
  appId: string;
  path: string;
  slug: string;
}

/**
 * The identity a ref would have as a not-yet-pushed app, or null when the ref
 * is not something an app can be addressed by (empty, unsafe, outside
 * `apps/` / `users/<handle>/apps/`).
 */
export function unregisteredDraftIdentity(
  workspaceId: string,
  ref: string,
): UnregisteredDraftIdentity | null {
  const clean = ref.trim().replace(/^\/+/, "").replace(/\/+$/, "");
  if (!clean) return null;
  if (isAppId(clean)) {
    const appId = clean.toLowerCase();
    // A manifest id says nothing about the folder; the path only keys repo
    // reads, which a draft of an unpushed app never finds anyway.
    return { appId, path: `${APPS_DIR}/${appId}`, slug: appId };
  }
  const path = clean.includes("/") ? clean : `${APPS_DIR}/${clean}`;
  const location = parseAppRepoPath(path);
  if (!location) return null;
  return {
    appId: derivedAppId(workspaceId, appKeyOf(path)).toString(),
    path,
    slug: location.slug,
  };
}

/** Swappable for tests; production reads the index and the rows. */
export interface UnregisteredDraftDeps {
  /** Does the workspace's index (main) know anything by this ref? */
  indexKnows: (workspaceId: string, ref: string) => Promise<boolean>;
  /** Is this id, path or slug taken by an index entry or project row? */
  taken: (
    workspaceId: string,
    identity: UnregisteredDraftIdentity,
  ) => Promise<boolean>;
}

const defaultDeps: UnregisteredDraftDeps = {
  indexKnows: async (workspaceId, ref) => {
    const snapshot = await loadAppsIndex(workspaceId);
    const clean = ref.trim().replace(/^\/+/, "").replace(/\/+$/, "");
    const stripped = clean.replace(/^apps\//, "");
    // findAppInSnapshot refuses an ambiguous slug; that slug is still taken.
    return (
      findAppInSnapshot(snapshot, clean) !== null ||
      snapshot.apps.some(a => a.slug === stripped || a.path === clean)
    );
  },
  taken: async (workspaceId, identity) => {
    const id = new Types.ObjectId(identity.appId);
    const ws = new Types.ObjectId(workspaceId);
    // Ids are global: index entries are unique on appId across workspaces.
    const [entry, row] = await Promise.all([
      AppIndexEntry.exists({ appId: identity.appId }),
      AppProject.exists({
        $or: [
          { _id: id },
          { workspaceId: ws, path: identity.path },
          { workspaceId: ws, slug: identity.slug },
        ],
      }),
    ]);
    return entry !== null || row !== null;
  },
};

/**
 * The synthesized project a draft dev build of a not-yet-pushed app runs
 * against, or null when the ref names (or could name) a real app — then the
 * caller answers exactly what it answered before.
 */
export async function unregisteredDraftProject(
  workspaceId: string,
  ref: string,
  ownerId: string | undefined,
  deps: UnregisteredDraftDeps = defaultDeps,
): Promise<IAppProject | null> {
  if (!Types.ObjectId.isValid(workspaceId)) return null;
  const identity = unregisteredDraftIdentity(workspaceId, ref);
  if (!identity) return null;
  if (await deps.indexKnows(workspaceId, ref)) return null;
  if (await deps.taken(workspaceId, identity)) return null;
  return {
    _id: new Types.ObjectId(identity.appId),
    workspaceId: new Types.ObjectId(workspaceId),
    title: identity.slug,
    slug: identity.slug,
    path: identity.path,
    access: "private",
    ...(ownerId ? { owner_id: ownerId } : {}),
    createdBy: ownerId ?? "",
    defaultBranch: DEFAULT_BRANCH,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as IAppProject;
}

/**
 * May this caller build drafts for an app that is not on main yet? The same
 * bar as creating an app: a workspace member who is not a `viewer`. A
 * workspace API key (no user) is the workspace's, as everywhere in the apps
 * routes. Answers "none" (not a member: 404), "read" (a viewer: 403 on a
 * build) or "write".
 */
export function unregisteredDraftAccess(
  userId: string | undefined,
  memberRole: string | undefined,
): "none" | "read" | "write" {
  if (!userId) return "write";
  if (!memberRole) return "none";
  return memberRole === "viewer" ? "read" : "write";
}

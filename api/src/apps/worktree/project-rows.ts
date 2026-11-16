/**
 * Apps are folders (§13): folder-only apps synthesized from the index, the
 * row a few acts give them, and resolving an id / path / slug to a project.
 */
import { Types } from "mongoose";
import { AppProject, type IAppProject } from "../../database/workspace-schema";
import { DEFAULT_BRANCH } from "../repository.service";
import {
  loadAppsIndex,
  resolveAppRef,
  type AppIndexRow,
} from "../app-index.service";
import { USERS_DIR, parseAppRepoPath } from "../app-paths";
import { loadOwnerDirectory } from "../user-handles.service";

import { appRootFor } from "./repo";
import { isPersonActorId, isUserActor } from "./worktrees";

// ---------------------------------------------------------------------------
// Apps are folders (§13): the repo is the list, not the database
// ---------------------------------------------------------------------------

/** One app as the list knows it: an index row, by any other name. */
export type AppFolder = AppIndexRow & { id: string };

/**
 * Every app in a workspace, read from the repo (through the apps index).
 *
 * An app is a folder with a `mako.json`, anywhere under `apps/` or
 * `users/<handle>/apps/`; that is the whole definition. It exists because the
 * folder exists, not because a row does — so pushing a folder from a local
 * checkout makes the app appear, and no registration step is needed.
 *
 * Mongo keeps only what genuinely cannot live in a repo the customer can
 * clone: who may see the app, what sha is deployed, and a share token with its
 * password hash. Those are server state ABOUT an app, not the app. The index
 * rows are a derived read model of the tree, rebuilt when main moves.
 */
export async function listAppFolders(
  workspaceId: string,
): Promise<AppFolder[]> {
  // A missing GitHub binding is an empty list, not a 412 (loadAppsIndex
  // answers EMPTY without a bound repo). Writes still 412 elsewhere.
  const snapshot = await loadAppsIndex(workspaceId);
  return snapshot.apps.map(app => ({ ...app, id: app.appId }));
}

/** The folders of both app trees, for the sidebar (empty ones included). */
export async function listAppFolderPaths(
  workspaceId: string,
): Promise<string[]> {
  return (await loadAppsIndex(workspaceId)).folders;
}

/**
 * Env flag that lets real 15-character user ids (isPersonActorId) own the
 * rows they CREATE. Off by default, so merging changes nothing; turned on
 * after scripts/backfill-app-row-owners.ts. It never widens the claim of an
 * EXISTING ownerless row: that stays isUserActor (24-hex), as before, so a
 * row the backfill left ownerless is not handed to whoever touches it next.
 */
export const ROW_OWNER_PERSON_IDS_FLAG = "APPS_ROW_OWNER_PERSON_IDS";

function rowOwnerPersonIdsOn(): boolean {
  const raw = (process.env[ROW_OWNER_PERSON_IDS_FLAG] ?? "")
    .trim()
    .toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/**
 * The acting id when it may own a row, else undefined. System actors
 * (publish, api-key, scheduler, app-chat, "") never qualify, flag or not.
 */
export function rowOwnerActor(actorId: string): string | undefined {
  const person = rowOwnerPersonIdsOn()
    ? isPersonActorId(actorId)
    : isUserActor(actorId);
  return person ? actorId : undefined;
}

/**
 * Persist the row for a folder-only app, keeping the DERIVED id so every
 * artifact key and worktree doc stays stable. The three row-creating acts
 * (§13.6: restrict, publish, share) all converge here; everything else keeps
 * reading the synthesized shape. Idempotent and race-safe: a concurrent
 * create loses the unique-index race and re-reads the winner.
 *
 * Publishing NEEDS this: `setPublishedSha` is an updateOne by _id, which
 * silently matches nothing for a synthesized project — the publish then
 * "succeeds" without persisting anything, and a reload shows the app
 * unpublished (found on prod with repo-imported apps, §13.22).
 */
export async function ensureProjectRow(
  project: IAppProject,
  actorId: string,
): Promise<IAppProject> {
  // Only a person can own an app. The push-deploy worker (PUBLISH_ACTOR), an
  // API key with no acting user ("") and similar sentinels create the row
  // ownerless; otherwise the auto-deploy of every repo-imported folder would
  // stamp the literal "publish" as owner_id, nobody could ever restrict or
  // share it, and a private access setting would lock out even admins.
  const actor = rowOwnerActor(actorId);
  // A folder under users/<handle>/apps belongs to its owner (§29). The owner
  // is the handle mapping's answer for the folder, whoever's action creates
  // or first touches the row. A segment the mapping does not know is nobody's:
  // the row stays ownerless.
  const personal = await personalTreeOwner(project);
  const owner = personal ? personal.ownerId : actor;
  // Claiming an existing ownerless row keeps the legacy 24-hex rule whatever
  // the flag says: those rows are the backfill's to settle, not the next
  // person's to take.
  const claimant = personal
    ? personal.ownerId
    : isUserActor(actorId)
      ? actorId
      : undefined;
  const existing = await AppProject.findOne({
    _id: project._id,
    workspaceId: project.workspaceId,
  });
  if (existing) {
    // An ownerless row gets its owner on the first act by a 24-hex actor
    // (resource-acl reads owner_id, then createdBy; see claimant above). A personal row's owner is the mapping's
    // answer. Outside a personal tree, a private row stays as it is: only a
    // workspace-visible app takes the acting person as its owner.
    if (
      claimant &&
      !existing.owner_id &&
      !existing.createdBy &&
      (personal || existing.access !== "private")
    ) {
      await AppProject.updateOne(
        {
          _id: existing._id,
          workspaceId: project.workspaceId,
          owner_id: { $in: [null, ""] },
        },
        { $set: { owner_id: claimant, createdBy: claimant } },
      );
      return (
        (await AppProject.findOne({
          _id: existing._id,
          workspaceId: project.workspaceId,
        })) ?? existing
      );
    }
    return existing;
  }
  try {
    return await AppProject.create({
      _id: project._id,
      workspaceId: project.workspaceId,
      title: project.title,
      slug: project.slug,
      path: project.path ?? appRootFor(project),
      description: project.description,
      access: personal ? "private" : (project.access ?? "workspace"),
      createdBy: project.createdBy || owner || "",
      ...(owner ? { owner_id: owner } : {}),
      defaultBranch: project.defaultBranch || DEFAULT_BRANCH,
    });
  } catch {
    const winner = await AppProject.findOne({
      _id: project._id,
      workspaceId: project.workspaceId,
    });
    if (winner) return winner;
    throw new Error("Could not persist the app's project row");
  }
}

/**
 * For an app in a personal tree (`users/<handle>/apps/…`): its owner by the
 * workspace's handle mapping (undefined when the segment is nobody's). Null
 * for a workspace-tree app, whose row keeps going to the acting person.
 */
async function personalTreeOwner(
  project: IAppProject,
): Promise<{ ownerId: string | undefined } | null> {
  const root = appRootFor(project);
  const location = parseAppRepoPath(root);
  if (location?.scope === "private") {
    const directory = await loadOwnerDirectory(project.workspaceId.toString());
    return { ownerId: directory.ownerOf(location.ownerHandle) ?? undefined };
  }
  // A path under users/ the parser refuses names no handle: it is nobody's.
  return root.startsWith(`${USERS_DIR}/`) ? { ownerId: undefined } : null;
}

/**
 * An app that exists only as a folder, shaped like a project document so every
 * read path works unchanged. Never persisted — writing a row is what happens
 * when someone restricts, publishes, or shares the app, not when they open it.
 */
export async function synthesizeProjectFromFolder(
  workspaceId: string,
  ref: string,
  options: {
    /**
     * On a miss, force one mirror fetch and look again (default true). The
     * read-after-push contract for every app_* tool: a folder pushed a
     * moment ago to another API instance resolves here on the first call,
     * without every HIT paying a GitHub round trip.
     */
    fetchOnMiss?: boolean;
  } = {},
): Promise<IAppProject | null> {
  const folder = await resolveAppRef(workspaceId, ref, {
    fetchOnMiss: options.fetchOnMiss !== false,
  });
  if (!folder) return null;
  return projectFromIndexRow(workspaceId, folder);
}

/** An index row shaped like a project document, never persisted. */
export function projectFromIndexRow(
  workspaceId: string,
  folder: AppIndexRow,
): IAppProject {
  return {
    _id: new Types.ObjectId(folder.appId),
    workspaceId: new Types.ObjectId(workspaceId),
    title: folder.title,
    slug: folder.slug,
    path: folder.path,
    description: folder.description,
    // A folder under users/<handle>/apps is that person's: private to them
    // until they share it, exactly like a private console.
    access: folder.scope === "private" ? "private" : "workspace",
    ...(folder.scope === "private" && folder.ownerId
      ? { owner_id: folder.ownerId }
      : {}),
    createdBy: "",
    defaultBranch: DEFAULT_BRANCH,
    createdAt: new Date(),
    updatedAt: new Date(),
  } as IAppProject;
}

/**
 * Resolve an app by id, path or slug: the project row when one exists
 * (sharing, deployment, env — with its path kept current by the index), the
 * synthesized shape when the app is only a folder, and the bare row when the
 * folder has left main (a published app whose folder was deleted keeps its
 * row until someone deletes the app). This is THE resolver; every route and
 * tool goes through it so id, path and slug all mean the same app.
 */
export async function resolveProjectRef(
  workspaceId: string,
  ref: string,
  options: { fetchOnMiss?: boolean } = {},
): Promise<IAppProject | null> {
  const ws = new Types.ObjectId(workspaceId);
  const clean = ref.trim().replace(/^\/+/, "");
  const folder = await resolveAppRef(workspaceId, clean, options);
  if (folder) {
    const row = await AppProject.findOne({
      _id: new Types.ObjectId(folder.appId),
      workspaceId: ws,
    });
    if (row) {
      // The index is the truth about WHERE the app is; the row may lag a
      // push by the length of one sync.
      if (row.path !== folder.path || row.slug !== folder.slug) {
        row.path = folder.path;
        row.slug = folder.slug;
      }
      return row;
    }
    return projectFromIndexRow(workspaceId, folder);
  }
  if (Types.ObjectId.isValid(clean) && /^[0-9a-f]{24}$/i.test(clean)) {
    return AppProject.findOne({
      _id: new Types.ObjectId(clean),
      workspaceId: ws,
    });
  }
  const stripped = clean.replace(/^apps\//, "");
  const byPath = await AppProject.findOne({ path: clean, workspaceId: ws });
  if (byPath) return byPath;
  // A bare slug the index knows but refused to pick (several nested apps
  // share the name, none at the top level) must stay unresolved: slugs are
  // no longer unique per workspace, and "whichever row Mongo returns first"
  // would edit, publish or serve bindings for the wrong app. The row lookup
  // is only for an app that has state but no folder on main any more.
  if (clean === stripped || clean.startsWith("apps/")) {
    const snapshot = await loadAppsIndex(workspaceId, { freshen: false });
    if (snapshot.apps.some(a => a.slug === stripped)) return null;
  }
  return AppProject.findOne({ slug: stripped, workspaceId: ws });
}

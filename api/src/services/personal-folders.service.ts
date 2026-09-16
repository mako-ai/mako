/**
 * Personal folders — one user's private grouping of entities inside a
 * workspace explorer.
 *
 * This is an organization layer and nothing else. The entities themselves are
 * never touched: an app goes on living at `apps/<slug>/` in the workspace repo
 * with no row of its own (apps.md §13.6), which is exactly why folders here
 * cannot be a `folderId` column the way notebooks/consoles/dashboards do it.
 * Membership is therefore stored as the entity's own durable key — the SLUG
 * for apps — and a key that no longer resolves is dropped by the explorer when
 * it renders, never repaired here. Nothing in this file can change what an app
 * is, who may see it, or where it deploys.
 *
 * `kind` keeps one collection serving every explorer ("app" today; notebooks,
 * consoles and dashboards can adopt it without a second migration).
 *
 * **The (workspaceId, userId) pair IS the authorization model.** Every query
 * filters on both, so a folder is unreachable by anyone but its author. There
 * is no sharing surface, no collaborator list, and no admin override — which
 * is what lets these routes skip the `canWriteResource` ACL the shared folder
 * registrar needs.
 */
import { Types } from "mongoose";

import { PersonalFolder } from "../database/workspace-schema";

/** Default explorer kind — the Apps panel is the first adopter. */
export const DEFAULT_PERSONAL_FOLDER_KIND = "app";

export const MAX_FOLDER_NAME_LENGTH = 120;
export const MAX_FOLDERS_PER_KIND = 100;
export const MAX_ITEMS_PER_FOLDER = 500;
/** An entity key (an app slug) — long enough for any real slug, bounded. */
export const MAX_ITEM_KEY_LENGTH = 200;

/** The wire shape; `_id` never leaves this module. */
export interface PersonalFolderJson {
  id: string;
  kind: string;
  name: string;
  items: string[];
  /** Present on the auto-created Starred list; absent on a user's folders. */
  system?: "starred";
  updatedAt?: string;
}

/** The display name of the one system list per (user, kind). */
export const STARRED_LIST_NAME = "Starred";

/** Mirrors `FolderOpResult` in `routes/lib/folder-routes.ts`. */
export type PersonalFolderResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409; error: string };

export interface PersonalFolderScope {
  workspaceId: string;
  userId: string;
}

interface PersonalFolderDocLike {
  _id: Types.ObjectId;
  kind: string;
  name: string;
  items?: string[];
  system?: "starred";
  updatedAt?: Date;
}

function toJson(doc: PersonalFolderDocLike): PersonalFolderJson {
  return {
    id: doc._id.toString(),
    kind: doc.kind,
    name: doc.name,
    items: [...(doc.items ?? [])],
    ...(doc.system ? { system: doc.system } : {}),
    updatedAt: doc.updatedAt?.toISOString(),
  };
}

/** Ordinary (user-made) folders only — the Starred list is a system row. */
const USER_FOLDER = { system: { $exists: false } } as const;

/** The scope filter every query starts from — workspace AND user, always. */
function scopeFilter(scope: PersonalFolderScope) {
  return {
    workspaceId: new Types.ObjectId(scope.workspaceId),
    userId: scope.userId,
  };
}

function normalizeName(raw: unknown): string {
  return typeof raw === "string" ? raw.trim() : "";
}

/**
 * Entity keys are caller-supplied, so they are trimmed, de-duplicated,
 * length-capped and emptied of blanks before they are ever stored.
 */
function normalizeKeys(raw: readonly string[] | undefined): string[] {
  if (!raw) return [];
  const out: string[] = [];
  for (const entry of raw) {
    if (typeof entry !== "string") continue;
    const key = entry.trim();
    if (!key || key.length > MAX_ITEM_KEY_LENGTH) continue;
    if (!out.includes(key)) out.push(key);
  }
  return out;
}

export async function listPersonalFolders(
  scope: PersonalFolderScope,
  kind: string = DEFAULT_PERSONAL_FOLDER_KIND,
): Promise<PersonalFolderJson[]> {
  const docs = await PersonalFolder.find({ ...scopeFilter(scope), kind })
    .sort({ name: 1 })
    .lean();
  return docs.map(doc => toJson(doc as unknown as PersonalFolderDocLike));
}

export async function createPersonalFolder(
  scope: PersonalFolderScope,
  input: { kind?: string; name: unknown },
): Promise<PersonalFolderResult<PersonalFolderJson>> {
  const name = normalizeName(input.name);
  if (!name) {
    return { ok: false, status: 400, error: "Folder name is required" };
  }
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `Folder name must be at most ${MAX_FOLDER_NAME_LENGTH} characters`,
    };
  }
  const kind = input.kind?.trim() || DEFAULT_PERSONAL_FOLDER_KIND;

  // The Starred list is not a folder the user made, so it is not counted.
  const existing = await PersonalFolder.countDocuments({
    ...scopeFilter(scope),
    kind,
    ...USER_FOLDER,
  });
  if (existing >= MAX_FOLDERS_PER_KIND) {
    return {
      ok: false,
      status: 409,
      error: `You already have the maximum of ${MAX_FOLDERS_PER_KIND} folders`,
    };
  }

  const doc = await PersonalFolder.create({
    ...scopeFilter(scope),
    kind,
    name,
    items: [],
  });
  return { ok: true, value: toJson(doc as unknown as PersonalFolderDocLike) };
}

export async function renamePersonalFolder(
  scope: PersonalFolderScope,
  input: { folderId: string; name: unknown },
): Promise<PersonalFolderResult<PersonalFolderJson>> {
  const name = normalizeName(input.name);
  if (!name) {
    return { ok: false, status: 400, error: "Folder name is required" };
  }
  if (name.length > MAX_FOLDER_NAME_LENGTH) {
    return {
      ok: false,
      status: 400,
      error: `Folder name must be at most ${MAX_FOLDER_NAME_LENGTH} characters`,
    };
  }
  if (!Types.ObjectId.isValid(input.folderId)) {
    return { ok: false, status: 404, error: "Folder not found" };
  }

  const id = new Types.ObjectId(input.folderId);
  const doc = await PersonalFolder.findOneAndUpdate(
    { ...scopeFilter(scope), _id: id, ...USER_FOLDER },
    { $set: { name } },
    { new: true },
  ).lean();
  if (!doc) return notFoundOrSystem(scope, id, "renamed");
  return { ok: true, value: toJson(doc as unknown as PersonalFolderDocLike) };
}

/**
 * A write that matched no user folder is either a folder that isn't yours
 * (404 — it must look nonexistent, never merely forbidden) or the Starred
 * list, which the user may empty but never rename or delete (400).
 */
async function notFoundOrSystem(
  scope: PersonalFolderScope,
  id: Types.ObjectId,
  verb: "renamed" | "deleted",
): Promise<PersonalFolderResult<never>> {
  const isSystem = await PersonalFolder.exists({
    ...scopeFilter(scope),
    _id: id,
    system: { $exists: true },
  });
  return isSystem
    ? {
        ok: false,
        status: 400,
        error: `The ${STARRED_LIST_NAME} list cannot be ${verb}`,
      }
    : { ok: false, status: 404, error: "Folder not found" };
}

export async function deletePersonalFolder(
  scope: PersonalFolderScope,
  folderId: string,
): Promise<PersonalFolderResult<string>> {
  if (!Types.ObjectId.isValid(folderId)) {
    return { ok: false, status: 404, error: "Folder not found" };
  }
  const id = new Types.ObjectId(folderId);
  const result = await PersonalFolder.deleteOne({
    ...scopeFilter(scope),
    _id: id,
    ...USER_FOLDER,
  });
  if (result.deletedCount === 0) {
    return notFoundOrSystem(scope, id, "deleted");
  }
  // Deleting a folder removes the grouping and nothing else — the apps it
  // listed are untouched and stay exactly where they were in My Apps /
  // Workspace.
  return { ok: true, value: folderId };
}

/**
 * Add and/or remove entity keys.
 *
 * Membership is computed as a set, so the operation is idempotent — dragging
 * the same app in twice is not an error and cannot duplicate a row. When a key
 * appears in both `add` and `remove`, **remove wins**.
 */
export async function updatePersonalFolderItems(
  scope: PersonalFolderScope,
  input: { folderId: string; add?: string[]; remove?: string[] },
): Promise<PersonalFolderResult<PersonalFolderJson>> {
  if (!Types.ObjectId.isValid(input.folderId)) {
    return { ok: false, status: 404, error: "Folder not found" };
  }
  const add = normalizeKeys(input.add);
  const remove = normalizeKeys(input.remove);

  const doc = await PersonalFolder.findOne({
    ...scopeFilter(scope),
    _id: new Types.ObjectId(input.folderId),
  });
  if (!doc) return { ok: false, status: 404, error: "Folder not found" };

  // A set, not $addToSet + $pull: Mongo refuses both operators on one path in
  // a single update, and the set keeps the whole thing idempotent.
  const next = new Set(doc.items);
  for (const key of add) next.add(key);
  for (const key of remove) next.delete(key);

  if (next.size > MAX_ITEMS_PER_FOLDER) {
    return {
      ok: false,
      status: 409,
      error: `A folder holds at most ${MAX_ITEMS_PER_FOLDER} items`,
    };
  }

  doc.items = [...next];
  await doc.save();

  // A user folder MOVES an entity within that user's view (Slack sections),
  // so it lives in at most one of them: filing it here pulls it from the
  // user's other folders of this kind. The Starred list is a shortcut and
  // is left alone — an app can be both starred and filed.
  if (!doc.system && add.length > 0) {
    await PersonalFolder.updateMany(
      {
        ...scopeFilter(scope),
        kind: doc.kind,
        _id: { $ne: doc._id },
        ...USER_FOLDER,
        items: { $in: add },
      },
      { $pull: { items: { $in: add } } },
    );
  }

  return { ok: true, value: toJson(doc as unknown as PersonalFolderDocLike) };
}

/**
 * Star or unstar one entity. The Starred list is created on first use, once
 * per (workspace, user, kind); the partial unique index makes a racing second
 * creation fail, and that failure is simply resolved by reading the winner.
 * Idempotent in both directions.
 */
export async function setStarred(
  scope: PersonalFolderScope,
  input: { kind?: string; key: string; starred: boolean },
): Promise<PersonalFolderResult<PersonalFolderJson>> {
  const [key] = normalizeKeys([input.key]);
  if (!key) return { ok: false, status: 400, error: "An item key is required" };
  const kind = input.kind?.trim() || DEFAULT_PERSONAL_FOLDER_KIND;
  const filter = { ...scopeFilter(scope), kind, system: "starred" as const };

  let doc = await PersonalFolder.findOne(filter);
  if (!doc) {
    try {
      doc = await PersonalFolder.create({
        ...filter,
        name: STARRED_LIST_NAME,
        items: [],
      });
    } catch (error) {
      const code = (error as { code?: number }).code;
      if (code !== 11000) throw error;
      doc = await PersonalFolder.findOne(filter);
      if (!doc) throw error;
    }
  }

  const next = new Set(doc.items);
  if (input.starred) next.add(key);
  else next.delete(key);
  if (next.size > MAX_ITEMS_PER_FOLDER) {
    return {
      ok: false,
      status: 409,
      error: `You can star at most ${MAX_ITEMS_PER_FOLDER} items`,
    };
  }
  doc.items = [...next];
  await doc.save();
  return { ok: true, value: toJson(doc as unknown as PersonalFolderDocLike) };
}

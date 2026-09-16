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
  updatedAt?: string;
}

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
  items: string[];
  updatedAt?: Date;
}

function toJson(doc: PersonalFolderDocLike): PersonalFolderJson {
  return {
    id: doc._id.toString(),
    kind: doc.kind,
    name: doc.name,
    items: [...doc.items],
    updatedAt: doc.updatedAt?.toISOString(),
  };
}

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

  const existing = await PersonalFolder.countDocuments({
    ...scopeFilter(scope),
    kind,
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

  const doc = await PersonalFolder.findOneAndUpdate(
    { ...scopeFilter(scope), _id: new Types.ObjectId(input.folderId) },
    { $set: { name } },
    { new: true },
  ).lean();
  if (!doc) return { ok: false, status: 404, error: "Folder not found" };
  return { ok: true, value: toJson(doc as unknown as PersonalFolderDocLike) };
}

export async function deletePersonalFolder(
  scope: PersonalFolderScope,
  folderId: string,
): Promise<PersonalFolderResult<string>> {
  if (!Types.ObjectId.isValid(folderId)) {
    return { ok: false, status: 404, error: "Folder not found" };
  }
  const result = await PersonalFolder.deleteOne({
    ...scopeFilter(scope),
    _id: new Types.ObjectId(folderId),
  });
  if (result.deletedCount === 0) {
    return { ok: false, status: 404, error: "Folder not found" };
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
  return { ok: true, value: toJson(doc as unknown as PersonalFolderDocLike) };
}

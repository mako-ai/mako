/**
 * Favourites — one person's bookmark tree over the workspace's entities.
 *
 * This is a VIEW, never a location. An app lives in its folder in the
 * workspace repo (`apps/sales/report`), a notebook in its folder, and so on;
 * starring pins a pointer to it here, in a tree of folders the user shapes
 * however they like — browser bookmarks, not a filing cabinet. Nothing in
 * this file can change what an entity is, who may see it, or where it lives,
 * which is why a star is instant and needs no commit.
 *
 * Shape: one self-referential table (Firefox's `moz_bookmarks`). Folders and
 * items are rows of the same kind; `parentId` nests them and `position`
 * orders siblings. An item is (kind, refId); an item that no longer resolves
 * is simply not rendered — the row is left alone, so a deleted-then-restored
 * entity reappears where it was.
 *
 * **The (workspaceId, userId) pair IS the authorization model.** Every query
 * filters on both; there is no sharing, no admin override.
 */
import { Types } from "mongoose";
import { Favourite, type FavouriteKind } from "../database/workspace-schema";

export const FAVOURITE_KINDS: readonly FavouriteKind[] = [
  "app",
  "console",
  "notebook",
  "dashboard",
];
export const MAX_FOLDER_NAME_LENGTH = 120;
export const MAX_FAVOURITE_DEPTH = 8;
export const MAX_FAVOURITES_PER_USER = 2000;

export interface FavouriteScope {
  workspaceId: string;
  userId: string;
}

/** The wire shape; `_id` never leaves this module. */
export interface FavouriteJson {
  id: string;
  parentId: string | null;
  type: "folder" | "item";
  title?: string;
  kind?: FavouriteKind;
  refId?: string;
  position: number;
}

export type FavouriteResult<T> =
  | { ok: true; value: T }
  | { ok: false; status: 400 | 404 | 409; error: string };

function fail<T>(status: 400 | 404 | 409, error: string): FavouriteResult<T> {
  return { ok: false, status, error };
}

function scopeFilter(scope: FavouriteScope) {
  return {
    workspaceId: new Types.ObjectId(scope.workspaceId),
    userId: scope.userId,
  };
}

function toJson(row: {
  _id: Types.ObjectId;
  parentId?: string | null;
  type: "folder" | "item";
  title?: string;
  kind?: FavouriteKind;
  refId?: string;
  position: number;
}): FavouriteJson {
  return {
    id: row._id.toString(),
    parentId: row.parentId ?? null,
    type: row.type,
    ...(row.type === "folder" ? { title: row.title ?? "" } : {}),
    ...(row.type === "item" ? { kind: row.kind, refId: row.refId } : {}),
    position: row.position,
  };
}

/** Every favourite of this person in this workspace, tree order by parent. */
export async function listFavourites(
  scope: FavouriteScope,
): Promise<FavouriteJson[]> {
  const rows = await Favourite.find(scopeFilter(scope))
    .sort({ parentId: 1, position: 1, _id: 1 })
    .lean();
  return rows.map(toJson);
}

async function nextPosition(
  scope: FavouriteScope,
  parentId: string | null,
): Promise<number> {
  const last = await Favourite.findOne({ ...scopeFilter(scope), parentId })
    .sort({ position: -1 })
    .select("position")
    .lean();
  return (last?.position ?? -1) + 1;
}

/** A folder this person owns, or null. */
async function ownFolder(
  scope: FavouriteScope,
  id: string,
): Promise<{ _id: Types.ObjectId; parentId: string | null } | null> {
  if (!Types.ObjectId.isValid(id)) return null;
  const row = await Favourite.findOne({
    ...scopeFilter(scope),
    _id: new Types.ObjectId(id),
    type: "folder",
  })
    .select("_id parentId")
    .lean();
  return row ? { _id: row._id, parentId: row.parentId ?? null } : null;
}

/**
 * Walk up from `folderId`; the depth, or -1 when the chain reaches `avoid`
 * (moving a folder into its own descendant).
 */
async function depthOf(
  scope: FavouriteScope,
  folderId: string | null,
  avoid?: string,
): Promise<number> {
  let depth = 0;
  let current = folderId;
  while (current) {
    if (avoid && current === avoid) return -1;
    const folder = await ownFolder(scope, current);
    if (!folder) return -1;
    depth++;
    if (depth > MAX_FAVOURITE_DEPTH) return depth;
    current = folder.parentId;
  }
  return depth;
}

async function assertRoom(scope: FavouriteScope): Promise<string | null> {
  const count = await Favourite.countDocuments(scopeFilter(scope));
  return count >= MAX_FAVOURITES_PER_USER
    ? `Favourites are limited to ${MAX_FAVOURITES_PER_USER} entries`
    : null;
}

export async function createFavouriteFolder(
  scope: FavouriteScope,
  input: { title: string; parentId?: string | null },
): Promise<FavouriteResult<FavouriteJson>> {
  const title = input.title.trim();
  if (!title) return fail(400, "A folder needs a name");
  if (title.length > MAX_FOLDER_NAME_LENGTH) {
    return fail(
      400,
      `Folder names are limited to ${MAX_FOLDER_NAME_LENGTH} characters`,
    );
  }
  const parentId = input.parentId ?? null;
  if (parentId) {
    const depth = await depthOf(scope, parentId);
    if (depth < 0) return fail(404, "Parent folder not found");
    if (depth >= MAX_FAVOURITE_DEPTH) {
      return fail(400, `Folders nest at most ${MAX_FAVOURITE_DEPTH} deep`);
    }
  }
  const room = await assertRoom(scope);
  if (room) return fail(409, room);
  const row = await Favourite.create({
    ...scopeFilter(scope),
    parentId,
    type: "folder",
    title,
    position: await nextPosition(scope, parentId),
  });
  return { ok: true, value: toJson(row) };
}

/**
 * Star an entity: idempotent, so a double click or two tabs racing cannot
 * create two rows (the partial unique index catches the race). Appends at
 * the end of the chosen folder (root by default).
 */
export async function addFavourite(
  scope: FavouriteScope,
  input: { kind: FavouriteKind; refId: string; parentId?: string | null },
): Promise<FavouriteResult<FavouriteJson>> {
  if (!FAVOURITE_KINDS.includes(input.kind)) {
    return fail(400, `Unknown kind: ${input.kind}`);
  }
  const refId = input.refId.trim();
  if (!refId || refId.length > 200) return fail(400, "Invalid entity id");
  const parentId = input.parentId ?? null;
  if (parentId && !(await ownFolder(scope, parentId))) {
    return fail(404, "Folder not found");
  }
  const existing = await Favourite.findOne({
    ...scopeFilter(scope),
    type: "item",
    kind: input.kind,
    refId,
  }).lean();
  if (existing) {
    // Idempotent star — but a star INTO a folder of something already
    // starred is a move, not a no-op: dropping a starred dashboard on a
    // Starred folder must land there rather than snap back.
    if (
      input.parentId !== undefined &&
      String(existing.parentId ?? "") !== String(parentId ?? "")
    ) {
      const moved = await Favourite.findOneAndUpdate(
        { _id: existing._id, ...scopeFilter(scope) },
        { $set: { parentId, position: await nextPosition(scope, parentId) } },
        { new: true },
      ).lean();
      return { ok: true, value: toJson(moved ?? existing) };
    }
    return { ok: true, value: toJson(existing) };
  }
  const room = await assertRoom(scope);
  if (room) return fail(409, room);
  try {
    const row = await Favourite.create({
      ...scopeFilter(scope),
      parentId,
      type: "item",
      kind: input.kind,
      refId,
      position: await nextPosition(scope, parentId),
    });
    return { ok: true, value: toJson(row) };
  } catch (error) {
    // Lost the unique-index race: the other writer's row is the answer.
    const winner = await Favourite.findOne({
      ...scopeFilter(scope),
      type: "item",
      kind: input.kind,
      refId,
    }).lean();
    if (winner) return { ok: true, value: toJson(winner) };
    throw error;
  }
}

/** Unstar by (kind, refId). Removing nothing is not an error. */
export async function removeFavouriteByRef(
  scope: FavouriteScope,
  input: { kind: FavouriteKind; refId: string },
): Promise<{ removed: boolean }> {
  const result = await Favourite.deleteOne({
    ...scopeFilter(scope),
    type: "item",
    kind: input.kind,
    refId: input.refId,
  });
  return { removed: result.deletedCount > 0 };
}

/**
 * Move a row (item or folder) to a folder and/or position, or rename a
 * folder. Siblings after the insertion point shift down; the row's old
 * siblings close the gap. A folder cannot become its own descendant.
 */
export async function updateFavourite(
  scope: FavouriteScope,
  id: string,
  patch: { parentId?: string | null; position?: number; title?: string },
): Promise<FavouriteResult<FavouriteJson>> {
  if (!Types.ObjectId.isValid(id)) return fail(404, "Favourite not found");
  const row = await Favourite.findOne({
    ...scopeFilter(scope),
    _id: new Types.ObjectId(id),
  });
  if (!row) return fail(404, "Favourite not found");

  const set: Record<string, unknown> = {};
  if (patch.title !== undefined) {
    if (row.type !== "folder") return fail(400, "Only folders have a title");
    const title = patch.title.trim();
    if (!title) return fail(400, "A folder needs a name");
    if (title.length > MAX_FOLDER_NAME_LENGTH) {
      return fail(
        400,
        `Folder names are limited to ${MAX_FOLDER_NAME_LENGTH} characters`,
      );
    }
    set.title = title;
  }

  const moving = patch.parentId !== undefined || patch.position !== undefined;
  if (moving) {
    const targetParent =
      patch.parentId === undefined ? (row.parentId ?? null) : patch.parentId;
    if (targetParent === id) return fail(400, "A folder cannot contain itself");
    if (targetParent) {
      const depth = await depthOf(scope, targetParent, id);
      if (depth < 0) {
        return fail(
          404,
          "Target folder not found (or is inside the folder being moved)",
        );
      }
      if (row.type === "folder" && depth >= MAX_FAVOURITE_DEPTH) {
        return fail(400, `Folders nest at most ${MAX_FAVOURITE_DEPTH} deep`);
      }
    }
    const siblings = await Favourite.find({
      ...scopeFilter(scope),
      parentId: targetParent,
      _id: { $ne: row._id },
    })
      .sort({ position: 1, _id: 1 })
      .select("_id")
      .lean();
    const wanted = patch.position ?? siblings.length;
    const index = Math.max(0, Math.min(wanted, siblings.length));
    const order = [
      ...siblings.slice(0, index).map(s => s._id),
      row._id,
      ...siblings.slice(index).map(s => s._id),
    ];
    const writes = order.map((sid, position) => ({
      updateOne: {
        filter: { _id: sid },
        update: {
          $set: sid.equals(row._id)
            ? { position, parentId: targetParent, ...set }
            : { position },
        },
      },
    }));
    await Favourite.bulkWrite(writes, { ordered: false });
    // Close the gap the row left behind, if it changed parent.
    const oldParent = row.parentId ?? null;
    if (oldParent !== targetParent) {
      const left = await Favourite.find({
        ...scopeFilter(scope),
        parentId: oldParent,
      })
        .sort({ position: 1, _id: 1 })
        .select("_id")
        .lean();
      if (left.length > 0) {
        await Favourite.bulkWrite(
          left.map((s, position) => ({
            updateOne: {
              filter: { _id: s._id },
              update: { $set: { position } },
            },
          })),
          { ordered: false },
        );
      }
    }
  } else if (Object.keys(set).length > 0) {
    await Favourite.updateOne({ _id: row._id }, { $set: set });
  }
  const fresh = await Favourite.findById(row._id).lean();
  return { ok: true, value: toJson(fresh ?? row) };
}

/**
 * Delete a row. A folder takes its whole subtree with it — those are only
 * pointers, and the entities they pointed at are untouched.
 */
export async function deleteFavourite(
  scope: FavouriteScope,
  id: string,
): Promise<FavouriteResult<{ removed: number }>> {
  if (!Types.ObjectId.isValid(id)) return fail(404, "Favourite not found");
  const root = await Favourite.findOne({
    ...scopeFilter(scope),
    _id: new Types.ObjectId(id),
  })
    .select("_id type")
    .lean();
  if (!root) return fail(404, "Favourite not found");
  const ids: Types.ObjectId[] = [root._id];
  if (root.type === "folder") {
    let frontier = [root._id.toString()];
    while (frontier.length > 0) {
      const children = await Favourite.find({
        ...scopeFilter(scope),
        parentId: { $in: frontier },
      })
        .select("_id")
        .lean();
      frontier = children.map(c => c._id.toString());
      ids.push(...children.map(c => c._id));
    }
  }
  const result = await Favourite.deleteMany({ _id: { $in: ids } });
  return { ok: true, value: { removed: result.deletedCount } };
}

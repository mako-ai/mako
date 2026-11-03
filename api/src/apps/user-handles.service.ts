/**
 * The workspace's handle ↔ userId mapping (see user-handles.ts), from Mongo.
 *
 * Handles are assigned lazily: the first read of a workspace's directory
 * hands every member without one a handle, oldest member first, so an
 * existing workspace, a newly joined member and the migration script all
 * get the same answer without a separate registration step. Rows are never
 * deleted (a departed member's handle stays theirs).
 */
import { Types } from "mongoose";
import { User } from "../database/schema";
import {
  WorkspaceMember,
  WorkspaceUserHandle,
} from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  OwnerDirectory,
  assignHandles,
  type HandleCandidate,
  type HandleRow,
} from "./user-handles";

const logger = loggers.api("user-handles");

/** Handles never change once assigned, so a short memo only delays newcomers. */
const TTL_MS = 30_000;

const cache = new Map<string, { at: number; directory: OwnerDirectory }>();
const loads = new Map<string, Promise<OwnerDirectory>>();

async function handleRows(workspaceId: string): Promise<HandleRow[]> {
  const rows = await WorkspaceUserHandle.find({
    workspaceId: new Types.ObjectId(workspaceId),
  })
    .select("userId handle")
    .lean();
  return rows.map(r => ({ userId: r.userId, handle: r.handle }));
}

/**
 * The handles a workspace has, plus the ones it WOULD assign: every current
 * member without one, oldest first, then `alsoUserIds` — people who are not
 * members (any more) but own content that needs a path, such as a departed
 * member's private console being re-filed. Read-only: the migration's dry
 * run plans with exactly what a write would store.
 */
export async function planWorkspaceHandles(
  workspaceId: string,
  alsoUserIds: string[] = [],
): Promise<{ existing: HandleRow[]; assigned: HandleRow[] }> {
  const ws = new Types.ObjectId(workspaceId);
  const [existing, members] = await Promise.all([
    handleRows(workspaceId),
    WorkspaceMember.find({ workspaceId: ws }).select("userId joinedAt").lean(),
  ]);
  const known = new Set(existing.map(r => r.userId));
  const memberIds = new Set(members.map(m => m.userId));
  const missing: Array<{ userId: string; joinedAt?: Date }> = [
    ...members.filter(m => !known.has(m.userId)),
    ...[...new Set(alsoUserIds)]
      .filter(id => id && !known.has(id) && !memberIds.has(id))
      // After every member: a departed person never takes a bare handle
      // from someone still here.
      .map(userId => ({ userId, joinedAt: undefined })),
  ];
  if (missing.length === 0) return { existing, assigned: [] };
  const users = await User.find({ _id: { $in: missing.map(m => m.userId) } })
    .select("_id email")
    .lean();
  const emailOf = new Map(users.map(u => [String(u._id), u.email]));
  const candidates: HandleCandidate[] = missing.flatMap(m => {
    const email = emailOf.get(m.userId);
    return email ? [{ userId: m.userId, email, joinedAt: m.joinedAt }] : [];
  });
  // No handle may spell an id this workspace knows: an old
  // `users/<thatId>/` folder must never resolve to someone else.
  const reserved = new Set([...memberIds, ...known, ...alsoUserIds]);
  return { existing, assigned: assignHandles(candidates, existing, reserved) };
}

/**
 * Store the planned handles and return all rows. Two instances racing
 * assign the same handles (the order is deterministic); the unique indexes
 * keep one and the loser re-plans.
 */
export async function ensureWorkspaceHandles(
  workspaceId: string,
  alsoUserIds: string[] = [],
): Promise<HandleRow[]> {
  const ws = new Types.ObjectId(workspaceId);
  for (let attempt = 0; attempt < 3; attempt++) {
    const { existing, assigned } = await planWorkspaceHandles(
      workspaceId,
      alsoUserIds,
    );
    if (assigned.length === 0) return existing;
    try {
      await WorkspaceUserHandle.insertMany(
        assigned.map(a => ({ workspaceId: ws, ...a })),
        { ordered: false },
      );
      logger.info("Assigned personal folder handles", {
        workspaceId,
        handles: assigned.length,
      });
      return [...existing, ...assigned];
    } catch (error) {
      // A concurrent assignment won some of them: re-read and go again.
      logger.warn("Handle assignment raced; retrying", {
        workspaceId,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return handleRows(workspaceId);
}

/**
 * The directory for a workspace. `forUserId`: a caller about to act in their
 * own tree — a memo that predates their membership is refreshed rather than
 * telling them they have no tree.
 */
export async function loadOwnerDirectory(
  workspaceId: string,
  options: { forUserId?: string } = {},
): Promise<OwnerDirectory> {
  const hit = cache.get(workspaceId);
  if (
    hit &&
    Date.now() - hit.at < TTL_MS &&
    (!options.forUserId || hit.directory.handleOf(options.forUserId))
  ) {
    return hit.directory;
  }
  const pending = loads.get(workspaceId);
  if (pending) return pending;
  const load = ensureWorkspaceHandles(workspaceId)
    .then(rows => {
      const directory = new OwnerDirectory(rows);
      cache.set(workspaceId, { at: Date.now(), directory });
      return directory;
    })
    .finally(() => loads.delete(workspaceId));
  loads.set(workspaceId, load);
  return load;
}

/**
 * The directory, guaranteed to hold a handle for `ownerId` when that user
 * exists at all — member or not. For writing a file under its owner's tree
 * (consoles, notebooks), where the owner may have left the workspace.
 */
export async function ownerDirectoryFor(
  workspaceId: string,
  ownerId: string | undefined,
): Promise<OwnerDirectory> {
  const directory = await loadOwnerDirectory(workspaceId, {
    forUserId: ownerId,
  });
  if (!ownerId || directory.handleOf(ownerId)) return directory;
  const rows = await ensureWorkspaceHandles(workspaceId, [ownerId]);
  const fresh = new OwnerDirectory(rows);
  cache.set(workspaceId, { at: Date.now(), directory: fresh });
  return fresh;
}

/** The caller's handle in this workspace, assigning one if needed. */
export async function handleForUser(
  workspaceId: string,
  userId: string | undefined,
): Promise<string | undefined> {
  if (!userId) return undefined;
  return (
    await loadOwnerDirectory(workspaceId, { forUserId: userId })
  ).handleOf(userId);
}

/** Forget the memo (tests; the migration script after writing rows). */
export function invalidateOwnerDirectory(workspaceId?: string): void {
  if (workspaceId) cache.delete(workspaceId);
  else cache.clear();
}

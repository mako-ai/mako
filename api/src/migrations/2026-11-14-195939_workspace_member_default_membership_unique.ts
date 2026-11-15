import { Db, ObjectId } from "mongodb";
import { loggers } from "../logging";
import { indexesOf } from "./index-helpers";

export const description =
  "Create the unique partial index guarding one default membership per user ({userId, isDefaultMembership} where isDefaultMembership=true), first clearing the flag on all but each user's oldest default membership";

const log = loggers.migration();

const KEY = { userId: 1, isDefaultMembership: 1 } as const;

function hasIndexOnKeys(
  indexes: { key: Record<string, unknown> }[],
  keyPattern: Record<string, number>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key) === target);
}

/**
 * The schema declared this guard as `{ userId: 1 }` (unique, partial on
 * `isDefaultMembership: true`), the same key as the plain `{ userId: 1 }`
 * index declared just before it. Mongoose drops an unnamed index whose key
 * duplicates an earlier one, so the guard was never built and concurrent
 * onboarding requests could each create a default workspace.
 *
 * Duplicates that slipped in meanwhile would make the unique build fail, so
 * they are resolved first WITHOUT deleting anything: each user's oldest
 * default membership (by joinedAt, then _id) keeps the flag, the others
 * only lose `isDefaultMembership` (they remain ordinary memberships of their
 * workspaces). Every change is logged.
 *
 * Idempotent: a re-run finds no duplicates and an existing index (checked
 * by key pattern). If a new duplicate lands between the cleanup and the
 * build, the build fails and a re-run resolves it.
 */
export async function up(db: Db): Promise<void> {
  const members = db.collection("workspacemembers");

  const duplicates = await members
    .aggregate<{
      _id: string;
      memberships: { id: ObjectId; joinedAt?: Date | null }[];
    }>([
      { $match: { isDefaultMembership: true } },
      {
        $group: {
          _id: "$userId",
          memberships: { $push: { id: "$_id", joinedAt: "$joinedAt" } },
          count: { $sum: 1 },
        },
      },
      { $match: { count: { $gt: 1 } } },
    ])
    .toArray();

  let cleared = 0;
  for (const dup of duplicates) {
    const ordered = [...dup.memberships].sort((a, b) => {
      const at = a.joinedAt ? new Date(a.joinedAt).getTime() : Infinity;
      const bt = b.joinedAt ? new Date(b.joinedAt).getTime() : Infinity;
      if (at !== bt) return at - bt;
      return a.id.toHexString().localeCompare(b.id.toHexString());
    });
    const [kept, ...rest] = ordered;
    const restIds = rest.map(m => m.id);
    const result = await members.updateMany(
      { _id: { $in: restIds }, isDefaultMembership: true },
      { $unset: { isDefaultMembership: "" } },
    );
    cleared += result.modifiedCount;
    log.warn("Cleared duplicate default memberships", {
      userId: dup._id,
      keptMembershipId: kept.id.toHexString(),
      clearedMembershipIds: restIds.map(id => id.toHexString()),
    });
  }

  const indexes = await indexesOf(members);
  if (hasIndexOnKeys(indexes, KEY)) {
    log.info("Default-membership unique index already present", {
      duplicateUsers: duplicates.length,
      cleared,
    });
    return;
  }

  await members.createIndex(KEY, {
    unique: true,
    partialFilterExpression: { isDefaultMembership: true },
  });
  log.info("Created default-membership unique index", {
    duplicateUsers: duplicates.length,
    cleared,
  });
}

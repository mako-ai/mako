/**
 * Shared branch-head pointer: the head SHA each workspace-repo branch has on
 * GitHub, as last seen by any API instance (`WorkspaceRepoHead`).
 *
 * Instance clones are read caches of GitHub. Before this pointer, a clone
 * learned it was behind only by fetching, so reads fetched on a timer and
 * could still miss a write another instance made a moment ago. Now every
 * server-side push (`commitToWorkspace`) and every GitHub push webhook moves
 * the pointer, and a read fetches exactly when its local head differs.
 *
 * Writers compare-and-swap on the previous SHA. A writer whose expectation
 * does not hold deletes the row rather than guess, because a pointer that
 * names an OLD sha is worse than none: a clone still at that old sha would
 * believe itself current. A missing row means "unknown": readers fall back to
 * a timed fetch until the next clean swap recreates it.
 *
 * Every function here is best-effort and never throws: the pointer is an
 * optimization over fetching, never a source of truth.
 */
import mongoose, { Types } from "mongoose";
import { WorkspaceRepoHead } from "../database/workspace-schema";
import { loggers } from "../logging";

const logger = loggers.api("apps");

/** `before` of a GitHub push that created the branch, `after` of one that deleted it. */
const ZERO_SHA = /^0{40}$/;

function mongoReady(workspaceId: string): boolean {
  // Unit tests run the git layer without a database; a query there would
  // buffer for the driver's timeout on every read.
  return (
    mongoose.connection.readyState === 1 && Types.ObjectId.isValid(workspaceId)
  );
}

/** The pointer's SHA for `branch`, or null when unknown. */
export async function readBranchHead(
  workspaceId: string,
  branch: string,
): Promise<string | null> {
  if (!mongoReady(workspaceId)) return null;
  try {
    const row = await WorkspaceRepoHead.findOne({
      workspaceId: new Types.ObjectId(workspaceId),
      branch,
    })
      .select("sha")
      .lean();
    return row?.sha ?? null;
  } catch (error) {
    logger.warn("Branch head pointer read failed", {
      workspaceId,
      branch,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/**
 * Move the pointer from `previous` to `next`.
 *
 * `previous` null (or GitHub's all-zero sha) means the branch did not exist,
 * so the row must not either. `next` all-zero deletes the branch's row.
 */
export async function advanceBranchHead(
  workspaceId: string,
  branch: string,
  previous: string | null | undefined,
  next: string,
): Promise<void> {
  if (!mongoReady(workspaceId)) return;
  const filter = { workspaceId: new Types.ObjectId(workspaceId), branch };
  try {
    if (ZERO_SHA.test(next)) {
      await WorkspaceRepoHead.deleteOne(filter);
      return;
    }
    const expected = previous && !ZERO_SHA.test(previous) ? previous : null;
    if (expected) {
      const swapped = await WorkspaceRepoHead.updateOne(
        { ...filter, sha: expected },
        { $set: { sha: next } },
      );
      if (swapped.matchedCount === 1) return;
    }
    // No row yet: the first writer to know the head creates it. A unique
    // index makes a concurrent creator lose, and the loser falls through.
    const existing = await WorkspaceRepoHead.findOne(filter)
      .select("sha")
      .lean();
    if (!existing) {
      try {
        await WorkspaceRepoHead.create({ ...filter, sha: next });
        return;
      } catch {
        // Lost the creation race; handled below like any mismatch.
      }
    } else if (existing.sha === next) {
      return;
    }
    // The pointer named something other than what this writer replaced:
    // another writer moved the branch in between, in an order this one cannot
    // see. Drop the row rather than leave either value standing.
    await WorkspaceRepoHead.deleteOne(filter);
  } catch (error) {
    logger.warn("Branch head pointer update failed", {
      workspaceId,
      branch,
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/**
 * Ids of deleted flows and dbt jobs, never handed to another file (see
 * `IRetiredObjectId`). The derived-id helpers (`freeDerivedFlowId`,
 * `freeDerivedJobId`) skip any generation held by a row of another slug;
 * a retired id is handed to them as such a holder, so the next free
 * generation is used instead.
 */
import { Types } from "mongoose";

import { RetiredObjectId } from "../database/workspace-schema";
import { loggers } from "../logging";

const logger = loggers.api("retired-ids");

export type RetirableKind = "flow" | "dbt_job";

/** A slug no file can have: a retired id never matches a live slug. */
const RETIRED = "\u0000retired";

/**
 * Record that `objectId` no longer names anything. Idempotent; never throws
 * (a delete must not fail because its bookkeeping did — it is logged).
 */
export async function retireObjectId(
  workspaceId: Types.ObjectId | string,
  kind: RetirableKind,
  objectId: Types.ObjectId | string,
  slug?: string,
): Promise<void> {
  try {
    await RetiredObjectId.updateOne(
      {
        workspaceId: new Types.ObjectId(String(workspaceId)),
        kind,
        objectId: new Types.ObjectId(String(objectId)),
      },
      { $setOnInsert: { slug, retiredAt: new Date() } },
      { upsert: true },
    );
  } catch (error) {
    logger.warn("Could not record a retired id", {
      workspaceId: String(workspaceId),
      kind,
      objectId: String(objectId),
      error: error instanceof Error ? error.message : String(error),
    });
  }
}

/** The retired ids of a workspace's `kind`, shaped as id holders. */
export async function retiredIdHolders(
  workspaceId: Types.ObjectId | string,
  kind: RetirableKind,
): Promise<Array<{ _id: Types.ObjectId; slug: string }>> {
  const retired = await RetiredObjectId.find({
    workspaceId: new Types.ObjectId(String(workspaceId)),
    kind,
  })
    .select("objectId")
    .lean();
  return retired.map(entry => ({ _id: entry.objectId, slug: RETIRED }));
}

export async function isRetiredObjectId(
  workspaceId: Types.ObjectId | string,
  kind: RetirableKind,
  objectId: string,
): Promise<boolean> {
  if (!Types.ObjectId.isValid(objectId)) return false;
  return Boolean(
    await RetiredObjectId.exists({
      workspaceId: new Types.ObjectId(String(workspaceId)),
      kind,
      objectId: new Types.ObjectId(objectId),
    }),
  );
}

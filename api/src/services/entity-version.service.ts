import { Types } from "mongoose";
import {
  EntityVersion,
  type IEntityVersion,
  type VersionableEntityType,
} from "../database/workspace-schema";
import { User } from "../database/schema";
import { loggers } from "../logging";

const logger = loggers.api("entity-versions");

export interface CreateVersionParams {
  entityType: VersionableEntityType;
  entityId: Types.ObjectId;
  workspaceId: Types.ObjectId;
  snapshot: Record<string, unknown>;
  savedBy: string;
  savedByName: string;
  comment: string;
  restoredFrom?: number;
}

export interface VersionListItem {
  version: number;
  savedBy: string;
  savedByName: string;
  comment: string;
  restoredFrom?: number;
  createdAt: Date;
}

export async function getLatestVersionNumber(
  entityId: Types.ObjectId,
  entityType: VersionableEntityType,
): Promise<number> {
  const latest = await EntityVersion.findOne(
    { entityId, entityType },
    { version: 1 },
  )
    .sort({ version: -1 })
    .lean();
  return latest?.version ?? 0;
}

const MAX_VERSION_RETRIES = 3;

export async function createVersion(
  params: CreateVersionParams,
): Promise<IEntityVersion> {
  for (let attempt = 0; attempt < MAX_VERSION_RETRIES; attempt++) {
    const nextVersion =
      (await getLatestVersionNumber(params.entityId, params.entityType)) + 1;

    try {
      const doc = await EntityVersion.create({
        workspaceId: params.workspaceId,
        entityType: params.entityType,
        entityId: params.entityId,
        version: nextVersion,
        snapshot: params.snapshot,
        savedBy: params.savedBy,
        savedByName: params.savedByName,
        comment: params.comment,
        restoredFrom: params.restoredFrom,
      });

      logger.debug("Version created", {
        entityType: params.entityType,
        entityId: params.entityId.toString(),
        version: nextVersion,
      });

      return doc;
    } catch (err: unknown) {
      const isDuplicateKey =
        err instanceof Error &&
        "code" in err &&
        (err as { code: number }).code === 11000;
      if (isDuplicateKey && attempt < MAX_VERSION_RETRIES - 1) {
        logger.warn("Version conflict, retrying", {
          entityId: params.entityId.toString(),
          attempt: attempt + 1,
        });
        continue;
      }
      throw err;
    }
  }

  throw new Error("Failed to create version after retries");
}

export async function listVersions(
  entityId: Types.ObjectId | string,
  entityType: VersionableEntityType,
  opts: {
    limit?: number;
    offset?: number;
    workspaceId?: Types.ObjectId | string;
  } = {},
): Promise<{ versions: VersionListItem[]; total: number }> {
  const eid =
    typeof entityId === "string" ? new Types.ObjectId(entityId) : entityId;
  const limit = Math.min(opts.limit ?? 50, 100);
  const offset = opts.offset ?? 0;

  const filter: Record<string, unknown> = { entityId: eid, entityType };
  if (opts.workspaceId) {
    filter.workspaceId =
      typeof opts.workspaceId === "string"
        ? new Types.ObjectId(opts.workspaceId)
        : opts.workspaceId;
  }

  const [versions, total] = await Promise.all([
    EntityVersion.find(filter, {
      version: 1,
      savedBy: 1,
      savedByName: 1,
      comment: 1,
      restoredFrom: 1,
      createdAt: 1,
    })
      .sort({ version: -1 })
      .skip(offset)
      .limit(limit)
      .lean<VersionListItem[]>(),
    EntityVersion.countDocuments(filter),
  ]);

  return { versions, total };
}

export async function getVersion(
  entityId: Types.ObjectId | string,
  entityType: VersionableEntityType,
  version: number,
  workspaceId?: Types.ObjectId | string,
): Promise<IEntityVersion | null> {
  const eid =
    typeof entityId === "string" ? new Types.ObjectId(entityId) : entityId;
  const filter: Record<string, unknown> = {
    entityId: eid,
    entityType,
    version,
  };
  if (workspaceId) {
    filter.workspaceId =
      typeof workspaceId === "string"
        ? new Types.ObjectId(workspaceId)
        : workspaceId;
  }
  return EntityVersion.findOne(filter).lean();
}

export async function getUserDisplayName(userId: string): Promise<string> {
  const u = await User.findById(userId, { email: 1 }).lean();
  return u?.email || userId;
}

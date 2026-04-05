import { Types } from "mongoose";
import {
  EntityVersion,
  type IEntityVersion,
  type VersionableEntityType,
} from "../database/workspace-schema";
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

export async function createVersion(
  params: CreateVersionParams,
): Promise<IEntityVersion> {
  const nextVersion =
    (await getLatestVersionNumber(params.entityId, params.entityType)) + 1;

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
}

export async function listVersions(
  entityId: Types.ObjectId | string,
  entityType: VersionableEntityType,
  opts: { limit?: number; offset?: number } = {},
): Promise<{ versions: VersionListItem[]; total: number }> {
  const eid =
    typeof entityId === "string" ? new Types.ObjectId(entityId) : entityId;
  const limit = Math.min(opts.limit ?? 50, 100);
  const offset = opts.offset ?? 0;

  const filter = { entityId: eid, entityType };

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
): Promise<IEntityVersion | null> {
  const eid =
    typeof entityId === "string" ? new Types.ObjectId(entityId) : entityId;
  return EntityVersion.findOne({
    entityId: eid,
    entityType,
    version,
  }).lean();
}

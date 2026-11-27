import { Types } from "mongoose";
import type { VersionableEntityType } from "../database/workspace-schema";
import { authRepo } from "../repositories/auth";
import {
  consolesChartsRepo,
  type EntityVersionListItem,
  type EntityVersionRecord,
} from "../repositories/consoles-charts";
import { loggers } from "../logging";

const logger = loggers.api("entity-versions");

export interface CreateVersionParams {
  entityType: VersionableEntityType;
  entityId: Types.ObjectId | string;
  workspaceId: Types.ObjectId | string;
  snapshot: Record<string, unknown>;
  savedBy: string;
  savedByName: string;
  comment: string;
  restoredFrom?: number;
}

export type VersionListItem = EntityVersionListItem;

export async function getLatestVersionNumber(
  entityId: Types.ObjectId | string,
  entityType: VersionableEntityType,
  workspaceId?: Types.ObjectId | string,
): Promise<number> {
  return consolesChartsRepo.getLatestEntityVersionNumber(
    String(entityId),
    entityType,
    workspaceId ? String(workspaceId) : undefined,
  );
}

export async function createVersion(
  params: CreateVersionParams,
): Promise<EntityVersionRecord> {
  const doc = await consolesChartsRepo.createEntityVersion({
    workspaceId: String(params.workspaceId),
    entityType: params.entityType,
    entityId: String(params.entityId),
    snapshot: params.snapshot,
    savedBy: params.savedBy,
    savedByName: params.savedByName,
    comment: params.comment,
    restoredFrom: params.restoredFrom,
  });

  logger.debug("Version created", {
    entityType: params.entityType,
    entityId: String(params.entityId),
    version: doc.version,
  });

  return doc;
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
  return consolesChartsRepo.listEntityVersions(String(entityId), entityType, {
    limit: opts.limit,
    offset: opts.offset,
    workspaceId: opts.workspaceId ? String(opts.workspaceId) : undefined,
  });
}

export async function getVersion(
  entityId: Types.ObjectId | string,
  entityType: VersionableEntityType,
  version: number,
  workspaceId?: Types.ObjectId | string,
): Promise<EntityVersionRecord | null> {
  return consolesChartsRepo.getEntityVersion(
    String(entityId),
    entityType,
    version,
    workspaceId ? String(workspaceId) : undefined,
  );
}

export async function getUserDisplayName(userId: string): Promise<string> {
  const u = await authRepo.findUserById(userId);
  return u?.email || userId;
}

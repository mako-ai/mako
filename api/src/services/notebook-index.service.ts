import { Types } from "mongoose";

import {
  NotebookIndex,
  type INotebookIndex,
} from "../database/workspace-schema";
import { getNotebookStore } from "../notebooks/store";
import { loggers } from "../logging";

const logger = loggers.api("notebook-index");

export type NotebookAccessLevel = "private" | "workspace";

export interface CreateNotebookIndexInput {
  workspaceId: string;
  notebookId: string;
  name: string;
  ownerId: string;
  access?: NotebookAccessLevel;
  workspaceRole?: "viewer" | "editor";
  folderId?: string | null;
  updatedAt?: Date;
}

export async function createNotebookIndex(
  input: CreateNotebookIndexInput,
): Promise<INotebookIndex> {
  const wsId = new Types.ObjectId(input.workspaceId);
  const access = input.access ?? "private";
  return NotebookIndex.create({
    notebookId: input.notebookId,
    workspaceId: wsId,
    name: input.name,
    ownerId: input.ownerId,
    access,
    workspaceRole:
      input.workspaceRole ?? (access === "workspace" ? "editor" : "viewer"),
    folderId: input.folderId ? new Types.ObjectId(input.folderId) : undefined,
    updatedAt: input.updatedAt ?? new Date(),
  });
}

export async function getNotebookIndex(
  workspaceId: string,
  notebookId: string,
): Promise<INotebookIndex | null> {
  return NotebookIndex.findOne({
    workspaceId: new Types.ObjectId(workspaceId),
    notebookId,
  });
}

/**
 * Ensure a Mongo index row exists for a notebook that is already in object
 * storage (legacy / deep-link open before the tree list backfill runs).
 */
export async function ensureNotebookIndexFromStore(
  workspaceId: string,
  notebookId: string,
): Promise<INotebookIndex | null> {
  const existing = await getNotebookIndex(workspaceId, notebookId);
  if (existing) return existing;

  const store = getNotebookStore();
  let doc: Awaited<ReturnType<typeof store.get>>;
  try {
    doc = await store.get(workspaceId, notebookId);
  } catch (error) {
    logger.warn("Failed to read notebook for index ensure", {
      workspaceId,
      notebookId,
      error,
    });
    return null;
  }
  if (!doc) return null;

  try {
    return await createNotebookIndex({
      workspaceId,
      notebookId,
      name: doc.name,
      ownerId: "system",
      access: "workspace",
      workspaceRole: "editor",
      updatedAt: new Date(doc.updatedAt),
    });
  } catch (error) {
    if ((error as { code?: number }).code === 11000) {
      return getNotebookIndex(workspaceId, notebookId);
    }
    throw error;
  }
}

export async function updateNotebookIndex(
  workspaceId: string,
  notebookId: string,
  patch: Partial<{
    name: string;
    folderId: string | null;
    access: NotebookAccessLevel;
    workspaceRole: "viewer" | "editor";
    updatedAt: Date;
  }>,
): Promise<INotebookIndex | null> {
  const $set: Record<string, unknown> = {};
  if (patch.name !== undefined) $set.name = patch.name;
  if (patch.access !== undefined) {
    $set.access = patch.access;
    if (patch.access === "workspace" && patch.workspaceRole === undefined) {
      $set.workspaceRole = "editor";
    }
  }
  if (patch.workspaceRole !== undefined) {
    $set.workspaceRole = patch.workspaceRole;
  }
  if (patch.updatedAt !== undefined) $set.updatedAt = patch.updatedAt;
  if (patch.folderId !== undefined) {
    $set.folderId = patch.folderId ? new Types.ObjectId(patch.folderId) : null;
  }

  return NotebookIndex.findOneAndUpdate(
    {
      workspaceId: new Types.ObjectId(workspaceId),
      notebookId,
    },
    { $set },
    { new: true },
  );
}

export async function deleteNotebookIndex(
  workspaceId: string,
  notebookId: string,
): Promise<boolean> {
  const result = await NotebookIndex.deleteOne({
    workspaceId: new Types.ObjectId(workspaceId),
    notebookId,
  });
  return result.deletedCount > 0;
}

/**
 * Backfill index rows for notebooks that exist in object storage but not yet
 * in Mongo (legacy notebooks). Preserves current behavior: workspace-visible
 * and editable by all workspace members.
 */
export async function syncNotebookIndexFromStore(
  workspaceId: string,
): Promise<void> {
  const wsId = new Types.ObjectId(workspaceId);
  const store = getNotebookStore();
  let summaries: Awaited<ReturnType<typeof store.list>>;
  try {
    summaries = await store.list(workspaceId);
  } catch (error) {
    logger.warn("Failed to list notebooks for index sync", {
      workspaceId,
      error,
    });
    return;
  }

  const existing = await NotebookIndex.find({ workspaceId: wsId })
    .select("notebookId name ownerId access workspaceRole")
    .lean();
  const byId = new Map(existing.map(row => [row.notebookId, row]));

  for (const summary of summaries) {
    const current = byId.get(summary.id);
    if (!current) {
      await NotebookIndex.create({
        notebookId: summary.id,
        workspaceId: wsId,
        name: summary.name,
        ownerId: "system",
        access: "workspace",
        workspaceRole: "editor",
        updatedAt: new Date(summary.updatedAt),
      });
      continue;
    }

    const $set: Record<string, unknown> = {};
    if (current.name !== summary.name) {
      $set.name = summary.name;
      $set.updatedAt = new Date(summary.updatedAt);
    }
    if (
      current.ownerId === "system" &&
      current.access === "workspace" &&
      current.workspaceRole !== "editor"
    ) {
      $set.workspaceRole = "editor";
    }
    if (Object.keys($set).length > 0) {
      await NotebookIndex.updateOne(
        { workspaceId: wsId, notebookId: summary.id },
        { $set },
      );
    }
  }
}

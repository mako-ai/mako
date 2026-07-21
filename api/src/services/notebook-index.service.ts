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
  folderId?: string | null;
  updatedAt?: Date;
}

export async function createNotebookIndex(
  input: CreateNotebookIndexInput,
): Promise<INotebookIndex> {
  const wsId = new Types.ObjectId(input.workspaceId);
  return NotebookIndex.create({
    notebookId: input.notebookId,
    workspaceId: wsId,
    name: input.name,
    ownerId: input.ownerId,
    access: input.access ?? "private",
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

export async function updateNotebookIndex(
  workspaceId: string,
  notebookId: string,
  patch: Partial<{
    name: string;
    folderId: string | null;
    access: NotebookAccessLevel;
    updatedAt: Date;
  }>,
): Promise<INotebookIndex | null> {
  const $set: Record<string, unknown> = {};
  if (patch.name !== undefined) $set.name = patch.name;
  if (patch.access !== undefined) $set.access = patch.access;
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
 * in Mongo (legacy notebooks). Preserves current behavior: workspace-visible.
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
    .select("notebookId name")
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
        updatedAt: new Date(summary.updatedAt),
      });
      continue;
    }
    if (current.name !== summary.name) {
      await NotebookIndex.updateOne(
        { workspaceId: wsId, notebookId: summary.id },
        {
          $set: {
            name: summary.name,
            updatedAt: new Date(summary.updatedAt),
          },
        },
      );
    }
  }
}

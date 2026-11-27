import { getNotebookStore } from "../notebooks/store";
import { loggers } from "../logging";
import {
  consolesChartsRepo,
  type NotebookIndexRecord,
} from "../repositories/consoles-charts";

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
): Promise<NotebookIndexRecord> {
  const access = input.access ?? "private";
  return consolesChartsRepo.createNotebookIndex({
    workspaceId: input.workspaceId,
    notebookId: input.notebookId,
    name: input.name,
    ownerId: input.ownerId,
    access,
    workspaceRole:
      input.workspaceRole ?? (access === "workspace" ? "editor" : "viewer"),
    folderId: input.folderId ?? null,
    updatedAt: input.updatedAt ?? new Date(),
  });
}

export async function getNotebookIndex(
  workspaceId: string,
  notebookId: string,
): Promise<NotebookIndexRecord | null> {
  return consolesChartsRepo.findNotebookIndex(workspaceId, notebookId);
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
): Promise<NotebookIndexRecord | null> {
  return consolesChartsRepo.updateNotebookIndex(workspaceId, notebookId, patch);
}

export async function deleteNotebookIndex(
  workspaceId: string,
  notebookId: string,
): Promise<boolean> {
  return consolesChartsRepo.deleteNotebookIndex(workspaceId, notebookId);
}

/**
 * Backfill index rows for notebooks that exist in object storage but not yet
 * in the database (legacy notebooks). Preserves current behavior: workspace-visible
 * and editable by all workspace members.
 */
export async function syncNotebookIndexFromStore(
  workspaceId: string,
): Promise<void> {
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

  const existing = await consolesChartsRepo.listNotebookIndexes(workspaceId);
  const byId = new Map(existing.map(row => [row.notebookId, row]));

  for (const summary of summaries) {
    const current = byId.get(summary.id);
    if (!current) {
      await consolesChartsRepo.createNotebookIndex({
        notebookId: summary.id,
        workspaceId,
        name: summary.name,
        ownerId: "system",
        access: "workspace",
        workspaceRole: "editor",
        updatedAt: new Date(summary.updatedAt),
      });
      continue;
    }

    const patch: Partial<{
      name: string;
      workspaceRole: "viewer" | "editor";
      updatedAt: Date;
    }> = {};
    if (current.name !== summary.name) {
      patch.name = summary.name;
      patch.updatedAt = new Date(summary.updatedAt);
    }
    if (
      current.ownerId === "system" &&
      current.access === "workspace" &&
      current.workspaceRole !== "editor"
    ) {
      patch.workspaceRole = "editor";
    }
    if (Object.keys(patch).length > 0) {
      await consolesChartsRepo.updateNotebookIndex(
        workspaceId,
        summary.id,
        patch,
      );
    }
  }
}

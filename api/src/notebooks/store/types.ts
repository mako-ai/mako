/**
 * NotebookStore — the persistence seam for notebook documents.
 *
 * Two implementations: GCS (durable + shareable across Cloud Run instances,
 * with object versioning for history) and filesystem (local-dev fallback). The
 * store owns *documents* (the source cells); large execution outputs are
 * offloaded to GCS under a separate prefix elsewhere so documents stay small.
 */
import { randomUUID } from "crypto";

import type { NotebookBlock, NotebookDoc, NotebookSummary } from "../types";

/** Notebook ids (UUID) and Mongo workspace ids (hex) both match this. */
export const ID_RE = /^[a-zA-Z0-9-]+$/;

export function nowIso(): string {
  return new Date().toISOString();
}

/** Build a fresh, empty notebook document. */
export function buildNewDoc(input: { name?: string }): NotebookDoc {
  const ts = nowIso();
  return {
    id: randomUUID(),
    name: (input.name || "").trim() || "Untitled notebook",
    blocks: [],
    version: 1,
    createdAt: ts,
    updatedAt: ts,
  };
}

/** Apply an update patch to an existing doc, bumping version + updatedAt. */
export function mergePatch(
  existing: NotebookDoc,
  patch: { name?: string; blocks?: NotebookBlock[] },
): NotebookDoc {
  return {
    ...existing,
    name:
      patch.name !== undefined
        ? patch.name.trim() || existing.name
        : existing.name,
    blocks: patch.blocks !== undefined ? patch.blocks : existing.blocks,
    version: (existing.version ?? 0) + 1,
    updatedAt: nowIso(),
  };
}

export interface NotebookStore {
  readonly kind: "gcs" | "filesystem";
  list(workspaceId: string): Promise<NotebookSummary[]>;
  get(workspaceId: string, id: string): Promise<NotebookDoc | null>;
  create(workspaceId: string, input: { name?: string }): Promise<NotebookDoc>;
  update(
    workspaceId: string,
    id: string,
    patch: { name?: string; blocks?: NotebookBlock[] },
  ): Promise<NotebookDoc | null>;
  remove(workspaceId: string, id: string): Promise<boolean>;
}

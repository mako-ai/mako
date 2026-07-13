/**
 * NotebookStore — the persistence seam for notebook documents.
 *
 * Two implementations: GCS (durable + shareable across Cloud Run instances,
 * with object versioning for history) and filesystem (local-dev fallback). The
 * store owns *documents* (the source cells); large execution outputs are
 * offloaded to GCS under a separate prefix elsewhere so documents stay small.
 */
import { randomUUID } from "crypto";

import type {
  NotebookBlock,
  NotebookDoc,
  NotebookSummary,
  NotebookVersion,
} from "../types";

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

  /**
   * Store a large output payload (a plot, HTML table, …) offloaded from a
   * notebook document, keyed by `artifactId` under the notebook. Overwrites any
   * existing object with the same id (ids are unique per output).
   */
  putArtifact(
    workspaceId: string,
    notebookId: string,
    artifactId: string,
    body: Buffer,
    contentType: string,
  ): Promise<void>;

  /** Fetch an offloaded output payload; `null` if it does not exist. */
  getArtifact(
    workspaceId: string,
    notebookId: string,
    artifactId: string,
  ): Promise<{ body: Buffer; contentType: string } | null>;

  /** Prior generations of a notebook, newest first (current included). Empty
   * if the notebook does not exist or the store keeps no history. */
  listVersions(workspaceId: string, id: string): Promise<NotebookVersion[]>;

  /** Fetch a specific prior generation's document; `null` if not found. */
  getVersion(
    workspaceId: string,
    id: string,
    versionId: string,
  ): Promise<NotebookDoc | null>;

  /** Restore a prior generation by writing its content as a new current
   * generation (non-destructive). Returns the new current doc, or `null` if
   * the notebook or version is not found. */
  restoreVersion(
    workspaceId: string,
    id: string,
    versionId: string,
  ): Promise<NotebookDoc | null>;
}

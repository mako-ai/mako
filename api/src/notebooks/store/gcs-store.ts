/**
 * GCS NotebookStore — the durable, shareable default in deployed environments.
 * One object per notebook; bucket object-versioning keeps prior generations so
 * a notebook's history is recoverable. Authenticated via Application Default
 * Credentials (the Cloud Run runtime SA), same as the dashboard artifact store.
 *
 * Object key: `documents/workspaces/<ws>/notebooks/<id>.json`. The notebook's
 * name + updatedAt are mirrored into object custom-metadata so `list()` reads
 * them straight from the bucket listing without downloading every document.
 */
import { Storage, type File } from "@google-cloud/storage";

import { loggers } from "../../logging";
import type {
  NotebookBlock,
  NotebookDoc,
  NotebookSummary,
  NotebookVersion,
} from "../types";
import {
  ID_RE,
  buildNewDoc,
  mergePatch,
  type NotebookStore,
} from "./types";

const logger = loggers.api("notebooks");

const MAX_UPDATE_RETRIES = 3;

function isNotFound(err: unknown): boolean {
  return (err as { code?: number })?.code === 404;
}
function isPreconditionFailed(err: unknown): boolean {
  return (err as { code?: number })?.code === 412;
}

export class GcsNotebookStore implements NotebookStore {
  readonly kind = "gcs" as const;
  private readonly storage = new Storage();
  private readonly bucketName: string;
  /** Environment-scoping prefix, e.g. `notebooks/prod` or `notebooks/pr-42`,
   * so preview envs (whose DBs are seeded from prod, sharing workspace ids)
   * never read or clobber production notebooks in the same bucket. */
  private readonly prefix: string;

  constructor(bucketName: string, prefix = "documents") {
    this.bucketName = bucketName;
    this.prefix = prefix.replace(/\/+$/, "");
  }

  private notebooksPrefix(workspaceId: string): string {
    if (!ID_RE.test(workspaceId)) throw new Error("Invalid workspaceId");
    return `${this.prefix}/workspaces/${workspaceId}/notebooks/`;
  }

  private objectKey(workspaceId: string, id: string): string {
    if (!ID_RE.test(id)) throw new Error("Invalid notebook id");
    return `${this.notebooksPrefix(workspaceId)}${id}.json`;
  }

  private file(workspaceId: string, id: string): File {
    return this.storage.bucket(this.bucketName).file(this.objectKey(workspaceId, id));
  }

  /** Offloaded output artifacts live under `…/notebooks/<id>/outputs/<artifactId>`. */
  private artifactFile(
    workspaceId: string,
    notebookId: string,
    artifactId: string,
  ): File {
    if (!ID_RE.test(notebookId)) throw new Error("Invalid notebook id");
    if (!ID_RE.test(artifactId)) throw new Error("Invalid artifact id");
    return this.storage
      .bucket(this.bucketName)
      .file(
        `${this.notebooksPrefix(workspaceId)}${notebookId}/outputs/${artifactId}`,
      );
  }

  private saveOptions(doc: NotebookDoc, ifGenerationMatch?: number | string) {
    return {
      contentType: "application/json",
      resumable: false,
      metadata: {
        metadata: {
          notebookName: doc.name,
          notebookUpdatedAt: doc.updatedAt,
        },
      },
      ...(ifGenerationMatch !== undefined
        ? { preconditionOpts: { ifGenerationMatch } }
        : {}),
    };
  }

  async list(workspaceId: string): Promise<NotebookSummary[]> {
    if (!ID_RE.test(workspaceId)) throw new Error("Invalid workspaceId");
    const [files] = await this.storage
      .bucket(this.bucketName)
      .getFiles({ prefix: this.notebooksPrefix(workspaceId) });

    const prefix = this.notebooksPrefix(workspaceId);
    const summaries: NotebookSummary[] = [];
    for (const file of files) {
      // Only direct `<id>.json` documents — skip nested artifact objects
      // (`<id>/outputs/<artifactId>`), which share the notebooks/ prefix.
      const rel = file.name.slice(prefix.length);
      if (!rel.endsWith(".json") || rel.includes("/")) continue;
      const id = rel.replace(/\.json$/, "");
      if (!id) continue;
      const meta = (file.metadata.metadata ?? {}) as Record<string, string>;
      summaries.push({
        id,
        name: meta.notebookName ?? "Untitled notebook",
        updatedAt: meta.notebookUpdatedAt ?? String(file.metadata.updated ?? ""),
      });
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(workspaceId: string, id: string): Promise<NotebookDoc | null> {
    if (!ID_RE.test(id)) return null;
    try {
      const [buf] = await this.file(workspaceId, id).download();
      return JSON.parse(buf.toString("utf8")) as NotebookDoc;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async create(
    workspaceId: string,
    input: { name?: string },
  ): Promise<NotebookDoc> {
    const doc = buildNewDoc(input);
    // ifGenerationMatch: 0 → create only; never clobber an existing object.
    await this.file(workspaceId, doc.id).save(
      JSON.stringify(doc, null, 2),
      this.saveOptions(doc, 0),
    );
    return doc;
  }

  async update(
    workspaceId: string,
    id: string,
    patch: { name?: string; blocks?: NotebookBlock[] },
  ): Promise<NotebookDoc | null> {
    if (!ID_RE.test(id)) return null;
    const file = this.file(workspaceId, id);

    for (let attempt = 0; attempt < MAX_UPDATE_RETRIES; attempt++) {
      let buf: Buffer;
      try {
        [buf] = await file.download();
      } catch (err) {
        if (isNotFound(err)) return null;
        throw err;
      }
      const existing = JSON.parse(buf.toString("utf8")) as NotebookDoc;
      const generation = file.metadata.generation ?? undefined;
      const next = mergePatch(existing, patch);
      try {
        await file.save(
          JSON.stringify(next, null, 2),
          this.saveOptions(next, generation),
        );
        return next;
      } catch (err) {
        // Someone else wrote between our read and write — re-read and retry.
        if (isPreconditionFailed(err) && attempt < MAX_UPDATE_RETRIES - 1) {
          logger.debug("notebook update precondition failed, retrying", { id });
          continue;
        }
        throw err;
      }
    }
    return null;
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    if (!ID_RE.test(id)) return false;
    try {
      await this.file(workspaceId, id).delete();
      return true;
    } catch (err) {
      if (isNotFound(err)) return false;
      throw err;
    }
  }

  async putArtifact(
    workspaceId: string,
    notebookId: string,
    artifactId: string,
    body: Buffer,
    contentType: string,
  ): Promise<void> {
    await this.artifactFile(workspaceId, notebookId, artifactId).save(body, {
      contentType,
      resumable: false,
    });
  }

  async getArtifact(
    workspaceId: string,
    notebookId: string,
    artifactId: string,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    if (!ID_RE.test(notebookId) || !ID_RE.test(artifactId)) return null;
    const file = this.artifactFile(workspaceId, notebookId, artifactId);
    try {
      const [meta] = await file.getMetadata();
      const [body] = await file.download();
      return {
        body,
        contentType: String(meta.contentType ?? "application/octet-stream"),
      };
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async listVersions(
    workspaceId: string,
    id: string,
  ): Promise<NotebookVersion[]> {
    if (!ID_RE.test(id)) return [];
    const key = this.objectKey(workspaceId, id);
    // `versions: true` returns every generation of the object; the live one has
    // no `timeDeleted`. Requires bucket object-versioning to be enabled — with
    // it off, only the current generation comes back (history shows one entry).
    const [files] = await this.storage
      .bucket(this.bucketName)
      .getFiles({ prefix: key, versions: true });
    return files
      .filter(f => f.name === key)
      .map(f => ({
        versionId: String(f.metadata.generation ?? ""),
        createdAt: String(f.metadata.timeCreated ?? f.metadata.updated ?? ""),
        size: Number(f.metadata.size ?? 0),
        isCurrent: !f.metadata.timeDeleted,
      }))
      .filter(v => v.versionId)
      .sort((a, b) => Number(b.versionId) - Number(a.versionId));
  }

  async getVersion(
    workspaceId: string,
    id: string,
    versionId: string,
  ): Promise<NotebookDoc | null> {
    if (!ID_RE.test(id) || !/^\d+$/.test(versionId)) return null;
    try {
      const [buf] = await this.storage
        .bucket(this.bucketName)
        .file(this.objectKey(workspaceId, id), { generation: Number(versionId) })
        .download();
      return JSON.parse(buf.toString("utf8")) as NotebookDoc;
    } catch (err) {
      if (isNotFound(err)) return null;
      throw err;
    }
  }

  async restoreVersion(
    workspaceId: string,
    id: string,
    versionId: string,
  ): Promise<NotebookDoc | null> {
    const version = await this.getVersion(workspaceId, id, versionId);
    if (!version) return null;
    // Non-destructive: write the old content as a new current generation.
    return this.update(workspaceId, id, {
      name: version.name,
      blocks: version.blocks,
    });
  }
}

/**
 * Filesystem NotebookStore — local-development fallback when no GCS bucket is
 * configured. Ephemeral on stateless Cloud Run (per-instance disk), which is
 * exactly why GCS is the default in deployed environments.
 *
 * Layout: `<NOTEBOOK_WORKDIR>/<workspaceId>/jupyter/<id>.json` (the `jupyter/`
 * folder mirrors where notebooks would live in a per-workspace repo).
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

import { loggers } from "../../logging";
import type {
  NotebookBlock,
  NotebookDoc,
  NotebookSummary,
  NotebookVersion,
} from "../types";
import { ID_RE, buildNewDoc, mergePatch, type NotebookStore } from "./types";

const logger = loggers.api("notebooks");

function baseDir(): string {
  return (
    process.env.NOTEBOOK_WORKDIR || path.join(os.tmpdir(), "mako-notebooks")
  );
}

function workspaceDir(workspaceId: string): string {
  if (!ID_RE.test(workspaceId)) {
    throw new Error("Invalid workspaceId");
  }
  return path.join(baseDir(), workspaceId, "jupyter");
}

function notebookPath(workspaceId: string, id: string): string {
  return path.join(workspaceDir(workspaceId), `${id}.json`);
}

function artifactPath(
  workspaceId: string,
  notebookId: string,
  artifactId: string,
): string {
  if (!ID_RE.test(notebookId)) throw new Error("Invalid notebook id");
  if (!ID_RE.test(artifactId)) throw new Error("Invalid artifact id");
  return path.join(
    workspaceDir(workspaceId),
    notebookId,
    "outputs",
    artifactId,
  );
}

function versionsDir(workspaceId: string, id: string): string {
  if (!ID_RE.test(id)) throw new Error("Invalid notebook id");
  return path.join(workspaceDir(workspaceId), id, "versions");
}

export class FilesystemNotebookStore implements NotebookStore {
  readonly kind = "filesystem" as const;

  async list(workspaceId: string): Promise<NotebookSummary[]> {
    const dir = workspaceDir(workspaceId);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }

    const summaries: NotebookSummary[] = [];
    for (const file of files) {
      if (!file.endsWith(".json")) continue;
      try {
        const doc = JSON.parse(
          await fs.readFile(path.join(dir, file), "utf8"),
        ) as NotebookDoc;
        summaries.push({
          id: doc.id,
          name: doc.name,
          updatedAt: doc.updatedAt,
        });
      } catch (err) {
        logger.warn("Skipping unreadable notebook file", { file, error: err });
      }
    }
    return summaries.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
  }

  async get(workspaceId: string, id: string): Promise<NotebookDoc | null> {
    if (!ID_RE.test(id)) return null;
    try {
      const raw = await fs.readFile(notebookPath(workspaceId, id), "utf8");
      return JSON.parse(raw) as NotebookDoc;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async create(
    workspaceId: string,
    input: { name?: string },
  ): Promise<NotebookDoc> {
    const doc = buildNewDoc(input);
    await this.write(workspaceId, doc);
    return doc;
  }

  async update(
    workspaceId: string,
    id: string,
    patch: { name?: string; blocks?: NotebookBlock[] },
  ): Promise<NotebookDoc | null> {
    const existing = await this.get(workspaceId, id);
    if (!existing) return null;
    const next = mergePatch(existing, patch);
    await this.write(workspaceId, next);
    return next;
  }

  async remove(workspaceId: string, id: string): Promise<boolean> {
    if (!ID_RE.test(id)) return false;
    try {
      await fs.unlink(notebookPath(workspaceId, id));
      return true;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return false;
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
    const file = artifactPath(workspaceId, notebookId, artifactId);
    await fs.mkdir(path.dirname(file), { recursive: true });
    await fs.writeFile(file, body);
    // Sidecar so getArtifact can serve the right Content-Type.
    await fs.writeFile(`${file}.type`, contentType, "utf8");
  }

  async getArtifact(
    workspaceId: string,
    notebookId: string,
    artifactId: string,
  ): Promise<{ body: Buffer; contentType: string } | null> {
    if (!ID_RE.test(notebookId) || !ID_RE.test(artifactId)) return null;
    const file = artifactPath(workspaceId, notebookId, artifactId);
    try {
      const body = await fs.readFile(file);
      let contentType = "application/octet-stream";
      try {
        contentType =
          (await fs.readFile(`${file}.type`, "utf8")).trim() || contentType;
      } catch {
        // missing sidecar — fall back to octet-stream
      }
      return { body, contentType };
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw err;
    }
  }

  async listVersions(
    workspaceId: string,
    id: string,
  ): Promise<NotebookVersion[]> {
    if (!ID_RE.test(id)) return [];
    const current = await this.get(workspaceId, id);
    if (!current) return [];
    const dir = versionsDir(workspaceId, id);
    let files: string[];
    try {
      files = await fs.readdir(dir);
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return [];
      throw err;
    }
    const versions: NotebookVersion[] = [];
    for (const file of files) {
      const versionId = file.replace(/\.json$/, "");
      if (!file.endsWith(".json") || !/^\d+$/.test(versionId)) continue;
      const stat = await fs.stat(path.join(dir, file));
      versions.push({
        versionId,
        createdAt: stat.mtime.toISOString(),
        size: stat.size,
        isCurrent: Number(versionId) === current.version,
      });
    }
    return versions.sort((a, b) => Number(b.versionId) - Number(a.versionId));
  }

  async getVersion(
    workspaceId: string,
    id: string,
    versionId: string,
  ): Promise<NotebookDoc | null> {
    if (!ID_RE.test(id) || !/^\d+$/.test(versionId)) return null;
    try {
      const raw = await fs.readFile(
        path.join(versionsDir(workspaceId, id), `${versionId}.json`),
        "utf8",
      );
      return JSON.parse(raw) as NotebookDoc;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code === "ENOENT") return null;
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
    return this.update(workspaceId, id, {
      name: version.name,
      blocks: version.blocks,
    });
  }

  private async write(workspaceId: string, doc: NotebookDoc): Promise<void> {
    const dir = workspaceDir(workspaceId);
    await fs.mkdir(dir, { recursive: true });
    const file = notebookPath(workspaceId, doc.id);
    const body = JSON.stringify(doc, null, 2);
    // Temp-file + rename so a crash mid-write never leaves a half-written file.
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, body, "utf8");
    await fs.rename(tmp, file);
    // Snapshot this generation so the history UI works in local dev (GCS gets
    // this for free via object versioning). Best-effort — never fail a write.
    try {
      const vdir = versionsDir(workspaceId, doc.id);
      await fs.mkdir(vdir, { recursive: true });
      await fs.writeFile(path.join(vdir, `${doc.version}.json`), body, "utf8");
    } catch (err) {
      logger.warn("Failed to write notebook version snapshot", {
        id: doc.id,
        version: doc.version,
        error: err,
      });
    }
  }
}

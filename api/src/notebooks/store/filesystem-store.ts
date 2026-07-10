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
import type { NotebookBlock, NotebookDoc, NotebookSummary } from "../types";
import {
  ID_RE,
  buildNewDoc,
  mergePatch,
  type NotebookStore,
} from "./types";

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
        summaries.push({ id: doc.id, name: doc.name, updatedAt: doc.updatedAt });
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

  private async write(workspaceId: string, doc: NotebookDoc): Promise<void> {
    const dir = workspaceDir(workspaceId);
    await fs.mkdir(dir, { recursive: true });
    const file = notebookPath(workspaceId, doc.id);
    // Temp-file + rename so a crash mid-write never leaves a half-written file.
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
    await fs.rename(tmp, file);
  }
}

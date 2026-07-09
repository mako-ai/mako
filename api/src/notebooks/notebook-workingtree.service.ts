/**
 * Notebook working-tree store (filesystem).
 *
 * Notebooks live in Git as the system of record (one repo per workspace, under
 * `jupyter/`). This service is the *working-tree* layer of that model — the
 * live, on-disk copy the app reads/writes — mirroring how the dbt engine
 * materializes a project to a working dir before Git sync layers on top
 * (`api/src/dbt/dbt-working-tree.service.ts`).
 *
 * FOLLOW-UPS (rest of the Git-storage slice): commit/sync the working tree to
 * GitHub (generalize the dbt-github-git/sync services), switch the on-disk
 * format to `.deepnote` YAML via `@deepnote/convert`, and offload large block
 * outputs to GCS. On stateless Cloud Run the working tree is ephemeral and
 * re-seeded from Git; locally it persists under NOTEBOOK_WORKDIR.
 */
import { promises as fs } from "fs";
import os from "os";
import path from "path";
import { randomUUID } from "crypto";

import { loggers } from "../logging";
import type { NotebookBlock, NotebookDoc, NotebookSummary } from "./types";

const logger = loggers.api("notebooks");

/** Ids we generate (UUID) and Mongo workspace ids (hex) both match this. */
const ID_RE = /^[a-zA-Z0-9-]+$/;

function baseDir(): string {
  return (
    process.env.NOTEBOOK_WORKDIR || path.join(os.tmpdir(), "mako-notebooks")
  );
}

/** `<base>/<workspaceId>/jupyter` — the `jupyter/` folder of the workspace repo. */
function workspaceDir(workspaceId: string): string {
  if (!ID_RE.test(workspaceId)) {
    throw new Error("Invalid workspaceId");
  }
  return path.join(baseDir(), workspaceId, "jupyter");
}

function notebookPath(workspaceId: string, id: string): string {
  return path.join(workspaceDir(workspaceId), `${id}.json`);
}

function nowIso(): string {
  return new Date().toISOString();
}

class NotebookWorkingTreeService {
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
    // Newest first.
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
    const ts = nowIso();
    const name = (input.name || "").trim() || "Untitled notebook";
    const doc: NotebookDoc = {
      id: randomUUID(),
      name,
      blocks: [],
      createdAt: ts,
      updatedAt: ts,
    };
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
    const next: NotebookDoc = {
      ...existing,
      name:
        patch.name !== undefined
          ? patch.name.trim() || existing.name
          : existing.name,
      blocks: patch.blocks !== undefined ? patch.blocks : existing.blocks,
      updatedAt: nowIso(),
    };
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
    // Write to a temp file then rename so a crash mid-write never leaves a
    // half-written notebook on disk.
    const tmp = `${file}.${randomUUID()}.tmp`;
    await fs.writeFile(tmp, JSON.stringify(doc, null, 2), "utf8");
    await fs.rename(tmp, file);
  }
}

export const notebookWorkingTreeService = new NotebookWorkingTreeService();

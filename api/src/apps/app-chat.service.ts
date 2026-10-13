/**
 * "Chat with app": what a published app's chat agent can see.
 *
 * The agent answers from the app's PUBLISHED bindings — the same parquet
 * files the app's viewers download as `__data/<name>.parquet` — resolved at
 * `publishedSha` exactly like published serving does. Nothing here re-runs a
 * query against a warehouse: a viewer gets no data through chat that the app
 * itself would not hand them.
 *
 * Artifacts live in the artifact store; DuckDB needs a local file, so each one
 * is cached on disk keyed by (artifact key, last write). Artifacts are
 * content-addressed by DEFINITION and rewritten in place on every scheduled
 * refresh, which is why the last-write time is part of the cache key.
 */
import { createHash } from "node:crypto";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { pipeline } from "node:stream/promises";
import type { IAppProject } from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  bindingArtifactKey,
  readBindingsTolerant,
  type AppBinding,
} from "./bindings.service";
import { artifactStoreForRead } from "./deployment.service";
import { globFiles, readFile, resolveProjectRef } from "./worktree.service";
import { resolveAppRef } from "./app-index.service";
import { workspaceService } from "../services/workspace.service";
import { canReadResource } from "../utils/resource-acl";
import type { AppDataTable } from "./app-chat-query";

const logger = loggers.api("apps-chat");

/** Reads attributed to the chat in git/sandbox logs. */
const CHAT_ACTOR = "app-chat";

/** A binding bigger than this is described but not queryable from chat. */
const MAX_BINDING_BYTES = 1024 * 1024 * 1024;
/** The on-disk cache is pruned (oldest first) back under this. */
const MAX_CACHE_BYTES = 4 * 1024 * 1024 * 1024;

function cacheDir(): string {
  return (
    process.env.APPS_CHAT_CACHE_DIR ?? path.join(os.tmpdir(), "mako-app-chat")
  );
}

export interface AppChatBinding {
  name: string;
  /** The query, front matter stripped — what defines the data. */
  code: string;
  /** Local parquet path, or null when the data is not available. */
  file: string | null;
  /** Why `file` is null. */
  unavailable?: string;
}

export interface AppChatData {
  sha: string;
  bindings: AppChatBinding[];
  /** Files under bindings/ that are not valid bindings. */
  skipped: Array<{ path: string; error: string }>;
}

export type AppChatAuthorization =
  | { ok: true; project: IAppProject; title: string }
  | { ok: false; status: 400 | 403 | 404; error: string };

/**
 * May `userId` chat with this app? Exactly the people who can open its live
 * link: read access to the app (`canReadResource`, the check `/live/` uses),
 * and the app must be published — chat answers from the published build.
 */
export async function authorizeAppChat(
  workspaceId: string,
  appRef: string,
  userId: string,
): Promise<AppChatAuthorization> {
  if (!appRef) return { ok: false, status: 400, error: "'appId' is required" };
  const project = await resolveProjectRef(workspaceId, appRef);
  const member = await workspaceService.getMember(workspaceId, userId);
  if (!project || !canReadResource(project, userId, member?.role)) {
    return { ok: false, status: 404, error: "App not found" };
  }
  if (!project.publishedSha) {
    return {
      ok: false,
      status: 400,
      error: "This app has not been published yet",
    };
  }
  // Off unless the owner turned it on (Share dialog).
  if (project.chatEnabled !== true) {
    return {
      ok: false,
      status: 403,
      error: "Chat is turned off for this app",
    };
  }
  const folder = await resolveAppRef(workspaceId, project._id.toString()).catch(
    () => null,
  );
  return {
    ok: true,
    project,
    title: folder?.title || project.title || project.slug || "Untitled app",
  };
}

const inflight = new Map<string, Promise<string>>();

async function pruneCache(): Promise<void> {
  const dir = cacheDir();
  const names = await fsp.readdir(dir).catch(() => [] as string[]);
  const files = (
    await Promise.all(
      names
        .filter(n => n.endsWith(".parquet"))
        .map(async n => {
          const full = path.join(dir, n);
          const stat = await fsp.stat(full).catch(() => null);
          return stat ? { full, size: stat.size, used: stat.mtimeMs } : null;
        }),
    )
  ).filter((f): f is { full: string; size: number; used: number } => !!f);
  let total = files.reduce((sum, f) => sum + f.size, 0);
  if (total <= MAX_CACHE_BYTES) return;
  files.sort((a, b) => a.used - b.used);
  for (const f of files) {
    if (total <= MAX_CACHE_BYTES) break;
    await fsp.rm(f.full, { force: true });
    total -= f.size;
  }
}

/** The artifact at `key` as a local file, downloading it when not cached. */
async function localArtifact(key: string): Promise<string> {
  const store = await artifactStoreForRead(key);
  if (!store) throw new Error("not materialized yet");
  const size = await store.getSize(key);
  if (size !== null && size > MAX_BINDING_BYTES) {
    throw new Error(
      `too large to query from chat (${Math.round(size / 1024 / 1024)} MB)`,
    );
  }
  const written = await store.getLastModified(key);
  const id = createHash("sha256")
    .update(`${key}\n${written?.toISOString() ?? ""}\n${size ?? ""}`)
    .digest("hex")
    .slice(0, 32);
  const file = path.join(cacheDir(), `${id}.parquet`);
  if (fs.existsSync(file)) {
    // Mark it used so pruning evicts the coldest files first.
    const now = new Date();
    await fsp.utimes(file, now, now).catch(() => undefined);
    return file;
  }

  const pending = inflight.get(file);
  if (pending) return pending;
  const download = (async () => {
    await fsp.mkdir(cacheDir(), { recursive: true });
    const stream = await store.openReadStream(key);
    if (!stream) throw new Error("not materialized yet");
    const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
    try {
      await pipeline(stream, fs.createWriteStream(tmp));
      await fsp.rename(tmp, file);
    } catch (error) {
      await fsp.rm(tmp, { force: true });
      throw error;
    }
    void pruneCache().catch(error =>
      logger.warn("App chat cache prune failed", { error }),
    );
    return file;
  })();
  inflight.set(file, download);
  try {
    return await download;
  } finally {
    inflight.delete(file);
  }
}

async function resolveBinding(binding: AppBinding): Promise<AppChatBinding> {
  const base = { name: binding.name, code: binding.code };
  if (binding.materialization === "live") {
    return {
      ...base,
      file: null,
      unavailable: "a live (dev-only) binding has no published data",
    };
  }
  try {
    const file = await localArtifact(
      bindingArtifactKey({
        connectionId: binding.connectionId,
        databaseId: binding.databaseId,
        databaseName: binding.databaseName,
        code: binding.code,
      }),
    );
    return { ...base, file };
  } catch (error) {
    return {
      ...base,
      file: null,
      unavailable: error instanceof Error ? error.message : String(error),
    };
  }
}

/** The published app's bindings, each with a local data file when it has one. */
export async function loadAppChatData(
  project: IAppProject,
): Promise<AppChatData> {
  const sha = project.publishedSha;
  if (!sha) throw new Error("This app has not been published yet");
  const { bindings, skipped } = await readBindingsTolerant(
    project,
    CHAT_ACTOR,
    sha,
  );
  return {
    sha,
    bindings: await Promise.all(bindings.map(resolveBinding)),
    skipped,
  };
}

/** The queryable subset, as DuckDB tables. */
export function queryableTables(data: AppChatData): AppDataTable[] {
  return data.bindings
    .filter((b): b is AppChatBinding & { file: string } => !!b.file)
    .map(b => ({ name: b.name, file: b.file }));
}

/** Source files in the published commit (app-relative paths). */
export async function listPublishedFiles(
  project: IAppProject,
  sha: string,
  limit = 300,
): Promise<string[]> {
  const files = await globFiles(project, "**/*", CHAT_ACTOR, limit + 1, sha);
  return files.slice(0, limit + 1);
}

/** One source file in the published commit. */
export async function readPublishedFile(
  project: IAppProject,
  sha: string,
  relPath: string,
): Promise<{ contents: string; isBinary: boolean; size: number }> {
  const file = await readFile(project, relPath, CHAT_ACTOR, sha);
  return { contents: file.contents, isBinary: file.isBinary, size: file.size };
}

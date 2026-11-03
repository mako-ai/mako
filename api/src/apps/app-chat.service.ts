/**
 * "Chat with app": what a published app's chat agent can see.
 *
 * The agent answers from the app's PUBLISHED bindings — the same parquet
 * files the app's viewers download as `__data/<name>.parquet` — resolved at
 * `publishedSha` exactly like published serving does. Nothing here re-runs a
 * query against a warehouse: a viewer gets no data through chat that the app
 * itself would not hand them.
 *
 * Artifacts live in the artifact store. By default DuckDB needs a local file,
 * so each one is cached on disk keyed by (artifact key, last write). Artifacts
 * are content-addressed by DEFINITION and rewritten in place on every scheduled
 * refresh, which is why the last-write time is part of the cache key.
 *
 * `APP_CHAT_PARQUET_DIRECT_GCS=1` skips the copy and lets DuckDB httpfs read
 * the object (signed https URL, or `gs://` with HMAC / OAuth). Default off.
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
import type { ArtifactStore } from "../services/artifact-store.service";
import type {
  AppChatGcsAuth,
  AppChatParquetMode,
  AppDataTable,
} from "./app-chat-query";

const logger = loggers.api("apps-chat");

/** Reads attributed to the chat in git/sandbox logs. */
const CHAT_ACTOR = "app-chat";

/** A binding bigger than this is described but not queryable from chat. */
const MAX_BINDING_BYTES = 1024 * 1024 * 1024;
/** The on-disk cache is pruned (oldest first) back under this. */
const MAX_CACHE_BYTES = 4 * 1024 * 1024 * 1024;
/** Signed URLs must outlive a chat turn, not just a browser follow-up. */
const DIRECT_GCS_URL_TTL_SECONDS = 3600;

function envFlagOn(name: string): boolean {
  const raw = (process.env[name] ?? "").trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "on" || raw === "yes";
}

/**
 * Opt-in: DuckDB httpfs reads the GCS object instead of copying it locally.
 * Default off so merging is safe; set `APP_CHAT_PARQUET_DIRECT_GCS=1`.
 */
export function isAppChatParquetDirectGcs(): boolean {
  return envFlagOn("APP_CHAT_PARQUET_DIRECT_GCS");
}

function hmacGcsAuth(): AppChatGcsAuth | null {
  const keyId = process.env.GCS_HMAC_KEY_ID?.trim();
  const secret = process.env.GCS_HMAC_SECRET?.trim();
  if (!keyId || !secret) return null;
  return { kind: "hmac", keyId, secret };
}

function cacheDir(): string {
  return (
    process.env.APPS_CHAT_CACHE_DIR ?? path.join(os.tmpdir(), "mako-app-chat")
  );
}

export interface AppChatBinding {
  name: string;
  /** The query, front matter stripped — what defines the data. */
  code: string;
  /** Local parquet path, gs:// URI, or signed https URL; null when unavailable. */
  file: string | null;
  /** Why `file` is null. */
  unavailable?: string;
  mode?: AppChatParquetMode;
  /** Copy mode: the local cache already had this file. */
  cacheHit?: boolean;
  /** Time to copy, sign, or mint a remote URL. */
  resolveMs?: number;
}

export interface AppChatData {
  sha: string;
  bindings: AppChatBinding[];
  /** Files under bindings/ that are not valid bindings. */
  skipped: Array<{ path: string; error: string }>;
  parquetMode: AppChatParquetMode;
  gcsAuth?: AppChatGcsAuth;
  /** Wall time to resolve every binding's parquet source. */
  resolveMs: number;
  /** True when copy mode downloaded at least one uncached file. */
  cold: boolean;
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

const inflight = new Map<
  string,
  Promise<{ file: string; cacheHit: boolean }>
>();

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

async function assertQueryableSize(
  store: ArtifactStore,
  key: string,
): Promise<void> {
  const size = await store.getSize(key);
  if (size !== null && size > MAX_BINDING_BYTES) {
    throw new Error(
      `too large to query from chat (${Math.round(size / 1024 / 1024)} MB)`,
    );
  }
}

/** The artifact at `key` as a local file, downloading it when not cached. */
async function localArtifact(
  key: string,
  store: ArtifactStore,
): Promise<{ file: string; cacheHit: boolean }> {
  await assertQueryableSize(store, key);
  const written = await store.getLastModified(key);
  const size = await store.getSize(key);
  const id = createHash("sha256")
    .update(`${key}\n${written?.toISOString() ?? ""}\n${size ?? ""}`)
    .digest("hex")
    .slice(0, 32);
  const file = path.join(cacheDir(), `${id}.parquet`);
  if (fs.existsSync(file)) {
    // Mark it used so pruning evicts the coldest files first.
    const now = new Date();
    await fsp.utimes(file, now, now).catch(() => undefined);
    return { file, cacheHit: true };
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
    return { file, cacheHit: false };
  })();
  inflight.set(file, download);
  try {
    return await download;
  } finally {
    inflight.delete(file);
  }
}

async function directArtifact(
  key: string,
  store: ArtifactStore,
): Promise<{ file: string; needsGcsAuth: boolean }> {
  if (store.type !== "gcs") {
    throw new Error("direct GCS reads require a GCS artifact store");
  }
  await assertQueryableSize(store, key);
  // Prefer a signed https URL: DuckDB never holds bucket credentials, and
  // httpfs cannot write over HTTPS. gs:// needs a secret; COPY to the
  // allow-listed object is not blocked (OAuth tokens are read-only; HMAC
  // keys may write if they can).
  try {
    const signed = await store.getSignedUrl(key, DIRECT_GCS_URL_TTL_SECONDS);
    if (signed) return { file: signed, needsGcsAuth: false };
  } catch (error) {
    logger.warn("App chat could not sign a GCS URL; trying gs://", {
      error: error instanceof Error ? error.message : String(error),
    });
  }
  const uri = store.gcsObjectUri?.(key) ?? null;
  if (uri) return { file: uri, needsGcsAuth: true };
  throw new Error("GCS store cannot produce a remote parquet URL");
}

async function mintGcsAuth(store: ArtifactStore): Promise<AppChatGcsAuth> {
  // HMAC first when set (DuckDB's native GCS path). Those keys are not
  // scoped read-only here; prefer signed HTTPS so DuckDB never holds them.
  const hmac = hmacGcsAuth();
  if (hmac) return hmac;
  const token = (await store.getOauthAccessToken?.()) ?? null;
  if (token) return { kind: "bearer", token };
  throw new Error(
    "Direct GCS parquet reads need GCS_HMAC_KEY_ID/GCS_HMAC_SECRET or an OAuth token from the GCS client",
  );
}

async function resolveBinding(
  binding: AppBinding,
  wantDirect: boolean,
): Promise<AppChatBinding> {
  const base = { name: binding.name, code: binding.code };
  if (binding.materialization === "live") {
    return {
      ...base,
      file: null,
      unavailable: "a live (dev-only) binding has no published data",
    };
  }
  const started = Date.now();
  const key = bindingArtifactKey({
    connectionId: binding.connectionId,
    databaseId: binding.databaseId,
    databaseName: binding.databaseName,
    code: binding.code,
  });
  try {
    const store = await artifactStoreForRead(key);
    if (!store) throw new Error("not materialized yet");
    if (wantDirect && store.type === "gcs") {
      const remote = await directArtifact(key, store);
      return {
        ...base,
        file: remote.file,
        mode: "direct",
        cacheHit: false,
        resolveMs: Date.now() - started,
      };
    }
    const local = await localArtifact(key, store);
    return {
      ...base,
      file: local.file,
      mode: "copy",
      cacheHit: local.cacheHit,
      resolveMs: Date.now() - started,
    };
  } catch (error) {
    return {
      ...base,
      file: null,
      unavailable: error instanceof Error ? error.message : String(error),
      resolveMs: Date.now() - started,
    };
  }
}

/** The published app's bindings, each with a parquet source when it has one. */
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
  const wantDirect = isAppChatParquetDirectGcs();
  const loadedAt = Date.now();
  let resolved = await Promise.all(
    bindings.map(b => resolveBinding(b, wantDirect)),
  );
  const queryable = () => resolved.filter(b => b.file);
  const mixed =
    queryable().some(b => b.mode === "direct") &&
    queryable().some(b => b.mode === "copy");
  if (mixed) {
    logger.warn(
      "App chat parquet mixed copy/direct sources; falling back to copy",
    );
    resolved = await Promise.all(bindings.map(b => resolveBinding(b, false)));
  }
  let gcsAuth: AppChatGcsAuth | undefined;
  const gsSource = bindings.find(binding => {
    const loaded = resolved.find(b => b.name === binding.name);
    return !!loaded?.file && /^gs:\/\//i.test(loaded.file);
  });
  if (gsSource) {
    const store = await artifactStoreForRead(bindingArtifactKey(gsSource));
    try {
      if (!store) {
        throw new Error(
          "GCS store missing while resolving a gs:// parquet URL",
        );
      }
      gcsAuth = await mintGcsAuth(store);
    } catch (error) {
      const unavailable =
        error instanceof Error ? error.message : String(error);
      logger.warn("Direct GCS auth failed; gs:// bindings unavailable", {
        error: unavailable,
      });
      resolved = resolved.map(b =>
        b.file && /^gs:\/\//i.test(b.file)
          ? { ...b, file: null, unavailable, mode: "direct" as const }
          : b,
      );
    }
  }
  const parquetMode: AppChatParquetMode =
    queryable().length > 0 && queryable().every(b => b.mode === "direct")
      ? "direct"
      : "copy";
  const resolveMs = Date.now() - loadedAt;
  const cold =
    parquetMode === "copy" && queryable().some(b => b.cacheHit === false);
  logger.debug("App chat parquet resolved", {
    mode: parquetMode,
    resolveMs,
    cold,
    tables: queryable().length,
    cacheHits: queryable().filter(b => b.cacheHit).length,
  });
  return {
    sha,
    bindings: resolved,
    skipped,
    parquetMode,
    gcsAuth,
    resolveMs,
    cold,
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

/**
 * Semantic app search, the stateful half: each app's embedding, kept in
 * `app_embeddings`, refreshed after the apps index moves, and scanned in
 * memory at query time (app-search.service blends it with the words).
 *
 * Never on the index or push path. The index schedules a refresh and
 * returns; the refresh re-reads only apps whose tree or path changed,
 * re-embeds only documents whose hash changed, in batches, and logs what
 * it did. A failure costs semantic matches for those apps, nothing else.
 *
 * Must not import app-index.service (it imports this module).
 */
import { Types } from "mongoose";
import { AppEmbedding } from "../database/workspace-schema";
import { loggers } from "../logging";
import {
  embedText,
  embedTexts,
  getEmbeddingModelName,
} from "../services/embedding.service";
import {
  UI_FILES_MAX,
  UI_FILE_MAX_BYTES,
  buildAppEmbeddingDocument,
  documentTerms,
  embeddingDocHash,
  isEmbeddingSourceFile,
} from "./app-embedding-doc";
import type { AppIndexRow, AppsIndexSnapshot } from "./app-index.service";
import { runGit } from "./git";
import { readBlobsBatch } from "./repository.service";
import { boundRepoDirIfExists } from "./workspace-repo-required";

const logger = loggers.api("app-embeddings");

/** Apps read, embedded and written per round trip. */
const BATCH = 32;
/** Workspace vectors are re-read from Mongo after this long. */
const VECTORS_FRESH_MS = 60_000;
const MAX_WORKSPACES = 200;
const MAX_QUERIES = 500;

// ---------------------------------------------------------------------------
// Refresh — after the index moves
// ---------------------------------------------------------------------------

const requestedSha = new Map<string, string>();
const inFlight = new Map<string, Promise<void>>();

/**
 * Bring a workspace's embeddings up to date with an index snapshot, in the
 * background. Once per (workspace, sha) per process unless `force` (the
 * search's backfill of apps it found without a vector); never twice at once.
 */
export function scheduleAppEmbeddings(
  workspaceId: string,
  snapshot: AppsIndexSnapshot,
  options: { force?: boolean } = {},
): void {
  if (!getEmbeddingModelName() || !snapshot.sha) return;
  if (inFlight.has(workspaceId)) return;
  if (!options.force && requestedSha.get(workspaceId) === snapshot.sha) return;
  requestedSha.set(workspaceId, snapshot.sha);
  const run = refreshAppEmbeddings(workspaceId, snapshot)
    .catch(error => {
      logger.warn("App embeddings refresh failed", {
        workspaceId,
        sha: snapshot.sha,
        error: error instanceof Error ? error.message : String(error),
      });
    })
    .finally(() => inFlight.delete(workspaceId));
  inFlight.set(workspaceId, run);
}

/** Tests: wait for the background refresh, if any. */
export function appEmbeddingsSettled(workspaceId: string): Promise<void> {
  return inFlight.get(workspaceId) ?? Promise.resolve();
}

/** The files under each app folder at a commit, with their sizes. */
async function listAppFiles(
  repoDir: string,
  sha: string,
  appPaths: string[],
): Promise<Map<string, Array<{ rel: string; size: number }>>> {
  const out = new Map<string, Array<{ rel: string; size: number }>>(
    appPaths.map(p => [p, []]),
  );
  if (appPaths.length === 0) return out;
  const { stdout } = await runGit(
    ["-C", repoDir, "ls-tree", "-r", "-l", "-z", sha, "--", ...appPaths],
    { timeoutMs: 60_000 },
  );
  const roots = [...appPaths].sort((a, b) => b.length - a.length);
  for (const record of stdout.split("\0")) {
    const tab = record.indexOf("\t");
    if (tab < 0) continue;
    const [, type, , size] = record.slice(0, tab).split(/\s+/);
    if (type !== "blob") continue;
    const file = record.slice(tab + 1);
    const root = roots.find(r => file.startsWith(`${r}/`));
    if (!root) continue;
    out.get(root)?.push({ rel: file.slice(root.length + 1), size: +size });
  }
  return out;
}

/** The search document of each app, read from git at the snapshot. */
export async function readAppEmbeddingDocs(
  repoDir: string,
  sha: string,
  apps: Array<Pick<AppIndexRow, "path" | "title" | "description" | "tables">>,
): Promise<Map<string, string>> {
  const files = await listAppFiles(
    repoDir,
    sha,
    apps.map(a => a.path),
  );
  const wanted: string[] = [];
  const plan = new Map<string, { readme?: string; ui: string[] }>();
  for (const app of apps) {
    const entry: { readme?: string; ui: string[] } = { ui: [] };
    for (const f of (files.get(app.path) ?? []).sort((a, b) =>
      a.rel.localeCompare(b.rel),
    )) {
      const kind = isEmbeddingSourceFile(f.rel);
      if (kind === "readme" && !entry.readme) entry.readme = f.rel;
      if (
        kind === "ui" &&
        f.size <= UI_FILE_MAX_BYTES &&
        entry.ui.length < UI_FILES_MAX
      ) {
        entry.ui.push(f.rel);
      }
    }
    plan.set(app.path, entry);
    if (entry.readme) wanted.push(`${app.path}/${entry.readme}`);
    for (const rel of entry.ui) wanted.push(`${app.path}/${rel}`);
  }
  const blobs = await readBlobsBatch(repoDir, sha, wanted);
  const text = (p: string) => blobs.get(p)?.toString("utf8");
  const docs = new Map<string, string>();
  for (const app of apps) {
    const entry = plan.get(app.path) ?? { ui: [] };
    docs.set(
      app.path,
      buildAppEmbeddingDocument({
        title: app.title,
        description: app.description,
        path: app.path,
        tables: app.tables,
        readme: entry.readme ? text(`${app.path}/${entry.readme}`) : undefined,
        sources: entry.ui.flatMap(rel => {
          const t = text(`${app.path}/${rel}`);
          return t ? [{ path: rel, text: t }] : [];
        }),
      }),
    );
  }
  return docs;
}

async function refreshAppEmbeddings(
  workspaceId: string,
  snapshot: AppsIndexSnapshot,
): Promise<void> {
  const model = getEmbeddingModelName();
  if (!model) return;
  const started = Date.now();
  const ws = new Types.ObjectId(workspaceId);
  const existing = await AppEmbedding.find({ workspaceId: ws })
    .select("appId path treeOid docHash embeddingModel")
    .lean();
  const byId = new Map(existing.map(e => [e.appId, e]));
  const live = new Set(snapshot.apps.map(a => a.appId));
  const gone = existing.filter(e => !live.has(e.appId));
  if (gone.length > 0) {
    await AppEmbedding.deleteMany({
      workspaceId: ws,
      appId: { $in: gone.map(e => e.appId) },
    });
  }
  // Title, description and tables live in the tree: same tree, same path,
  // same model ⇒ same document.
  const todo = snapshot.apps.filter(a => {
    const e = byId.get(a.appId);
    return (
      !e ||
      e.embeddingModel !== model ||
      e.treeOid !== a.treeOid ||
      e.path !== a.path
    );
  });
  let embedded = 0;
  let unchanged = 0;
  if (todo.length > 0) {
    const repoDir = await boundRepoDirIfExists(workspaceId);
    if (repoDir == null) return;
    for (let i = 0; i < todo.length; i += BATCH) {
      const batch = todo.slice(i, i + BATCH);
      const docs = await readAppEmbeddingDocs(repoDir, snapshot.sha, batch);
      const rows = batch.map(app => {
        const doc = docs.get(app.path) ?? app.title;
        return { app, doc, hash: embeddingDocHash(doc, model) };
      });
      const stale = rows.filter(r => byId.get(r.app.appId)?.docHash !== r.hash);
      const fresh = rows.filter(r => byId.get(r.app.appId)?.docHash === r.hash);
      const vectors =
        stale.length > 0 ? await embedTexts(stale.map(r => r.doc)) : [];
      const ops = [
        ...stale.flatMap((r, k) => {
          const vector = vectors[k];
          if (!vector) return [];
          return [
            {
              updateOne: {
                filter: { workspaceId: ws, appId: r.app.appId },
                update: {
                  $set: {
                    path: r.app.path,
                    treeOid: r.app.treeOid,
                    docHash: r.hash,
                    embeddingModel: model,
                    vector,
                    terms: documentTerms(r.doc),
                  },
                },
                upsert: true,
              },
            },
          ];
        }),
        ...fresh.map(r => ({
          updateOne: {
            filter: { workspaceId: ws, appId: r.app.appId },
            update: { $set: { path: r.app.path, treeOid: r.app.treeOid } },
          },
        })),
      ];
      if (ops.length > 0) {
        await AppEmbedding.bulkWrite(ops, { ordered: false });
      }
      embedded += stale.length;
      unchanged += fresh.length;
    }
  }
  if (gone.length > 0 || embedded > 0) vectorCache.delete(workspaceId);
  if (todo.length > 0 || gone.length > 0) {
    logger.info("App embeddings refreshed", {
      workspaceId,
      sha: snapshot.sha,
      apps: snapshot.apps.length,
      embedded,
      unchanged,
      removed: gone.length,
      ms: Date.now() - started,
    });
  }
}

// ---------------------------------------------------------------------------
// Query time
// ---------------------------------------------------------------------------

export interface WorkspaceVectors {
  at: number;
  model: string;
  vectors: Map<string, Float32Array>;
  terms: Map<string, string[]>;
}

const vectorCache = new Map<string, WorkspaceVectors>();

function unit(v: ArrayLike<number>): Float32Array {
  let norm = 0;
  for (let i = 0; i < v.length; i++) norm += v[i] * v[i];
  norm = Math.sqrt(norm) || 1;
  const out = new Float32Array(v.length);
  for (let i = 0; i < v.length; i++) out[i] = v[i] / norm;
  return out;
}

/**
 * A workspace's app vectors (unit length) and document words, memoized
 * for a minute.
 */
export async function workspaceAppVectors(
  workspaceId: string,
): Promise<WorkspaceVectors | null> {
  const model = getEmbeddingModelName();
  if (!model) return null;
  const cached = vectorCache.get(workspaceId);
  if (
    cached &&
    cached.model === model &&
    Date.now() - cached.at < VECTORS_FRESH_MS
  ) {
    return cached;
  }
  const rows = await AppEmbedding.find({
    workspaceId: new Types.ObjectId(workspaceId),
    embeddingModel: model,
  })
    .select("appId vector terms")
    .lean();
  const entry: WorkspaceVectors = {
    at: Date.now(),
    model,
    vectors: new Map(rows.map(r => [r.appId, unit(r.vector)])),
    terms: new Map(rows.map(r => [r.appId, r.terms ?? []])),
  };
  vectorCache.delete(workspaceId);
  vectorCache.set(workspaceId, entry);
  while (vectorCache.size > MAX_WORKSPACES) {
    vectorCache.delete(vectorCache.keys().next().value as string);
  }
  return entry;
}

const queryCache = new Map<string, Float32Array>();
const queryInFlight = new Map<string, Promise<Float32Array | null>>();

/**
 * A query's vector (unit length): from the LRU, else one gateway call. A
 * call that outlives the caller's patience still lands in the cache.
 */
export function embedSearchQuery(query: string): Promise<Float32Array | null> {
  const model = getEmbeddingModelName();
  const q = query.trim().toLowerCase().replace(/\s+/g, " ");
  if (!model || !q) return Promise.resolve(null);
  const key = `${model}\n${q}`;
  const hit = queryCache.get(key);
  if (hit) {
    queryCache.delete(key);
    queryCache.set(key, hit);
    return Promise.resolve(hit);
  }
  const pending = queryInFlight.get(key);
  if (pending) return pending;
  const call = embedText(q, {
    abortSignal: AbortSignal.timeout(10_000),
    maxRetries: 1,
  })
    .then(v => {
      if (!v) return null;
      const vec = unit(v);
      queryCache.set(key, vec);
      while (queryCache.size > MAX_QUERIES) {
        queryCache.delete(queryCache.keys().next().value as string);
      }
      return vec;
    })
    .finally(() => queryInFlight.delete(key));
  queryInFlight.set(key, call);
  return call;
}

/** Cosine of two unit vectors. */
export function dot(a: Float32Array, b: Float32Array): number {
  const n = Math.min(a.length, b.length);
  let s = 0;
  for (let i = 0; i < n; i++) s += a[i] * b[i];
  return s;
}

/** Tests: forget every memo. */
export function resetAppEmbeddingsState(): void {
  requestedSha.clear();
  vectorCache.clear();
  queryCache.clear();
}

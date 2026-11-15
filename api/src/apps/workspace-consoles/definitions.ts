/**
 * GET/list — git is the definition, Mongo is the overlay (apps.md §16).
 *
 * Parses the console files at `main` (cached per workspace, keyed by the
 * main sha, cold loads shared) and joins them with the derived index rows.
 * Pure reads: reconciliation belongs to the push and webhook paths.
 */
import { createHash } from "node:crypto";
import { Types } from "mongoose";
import {
  SavedConsole,
  type ISavedConsole,
} from "../../database/workspace-schema";
import type { OwnerDirectory } from "../user-handles";
import { loadOwnerDirectory } from "../user-handles.service";
import { boundRepoDirIfExists } from "../workspace-repo-required";
import {
  chartSidecarPath,
  parseChartSpec,
  parseConsoleFile,
  parseConsoleRepoPath,
  type ConsoleLanguage,
  type ConsoleRepoLocation,
  type ParsedConsoleFile,
} from "../console-files";
import { listTree, readBlobsBatch, resolveCommit } from "../repository.service";
import { BoundedMap } from "../../utils/bounded-map";
import { MAIN } from "./files";

/**
 * Stable id for a console that exists as a file but has no index row yet
 * (same contract as `derivedAppId`: the id is a function of identity, so a
 * later sync that creates the row does not mint a second one).
 */
export function derivedConsoleId(
  workspaceId: string,
  path: string,
): Types.ObjectId {
  const digest = createHash("sha1")
    .update(`consoles:${workspaceId}:${path}`)
    .digest("hex");
  return new Types.ObjectId(digest.slice(0, 24));
}

export interface ConsoleDefinitionAtMain {
  path: string;
  oid: string;
  location: ConsoleRepoLocation;
  parsed: ParsedConsoleFile;
  chartSpec?: Record<string, unknown>;
}

export interface LiveConsole extends ConsoleDefinitionAtMain {
  /** Derived index row when one exists (ACL, lastRun, embeddings, id). */
  row: ISavedConsole | null;
  /** Row `_id`, or a derived id when the file has no row yet. */
  id: Types.ObjectId;
}

/** Fill in each private definition's owner from the handle mapping. */
function resolveDefinitionOwners(
  defs: ConsoleDefinitionAtMain[],
  directory: OwnerDirectory,
): ConsoleDefinitionAtMain[] {
  for (const def of defs) {
    if (def.location.scope !== "private") continue;
    const owner = directory.ownerOf(def.location.ownerHandle);
    if (owner) def.location.ownerId = owner;
    else delete def.location.ownerId;
  }
  return defs;
}
// Full parsed console definitions per workspace: bounded (LRU) and expiring,
// so an instance does not keep every workspace it ever served. A miss only
// re-parses the tree at the (sha-checked) current main.
const consoleDefCache = new BoundedMap<
  string,
  { sha: string; defs: ConsoleDefinitionAtMain[] }
>({ maxEntries: 200, ttlMs: 30 * 60_000 });
const consoleDefLoads = new Map<
  string,
  { sha: string; promise: Promise<ConsoleDefinitionAtMain[]> }
>();

function isBinaryBuffer(buf: Buffer): boolean {
  return buf.includes(0);
}

/**
 * Authored console files at `main`. Empty when no GitHub repo is bound —
 * leftover local git is not a definition store (issue #956). Never throws
 * `RepoRequiredError`; a missing binding is an empty list, not 412.
 */
export async function listConsoleDefinitionsAtMain(
  workspaceId: string,
): Promise<ConsoleDefinitionAtMain[]> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return [];
  const sha = await resolveCommit(repoDir, MAIN);
  if (!sha) return [];
  const directory = await loadOwnerDirectory(workspaceId);
  const cached = consoleDefCache.get(workspaceId);
  if (cached && cached.sha === sha) {
    return resolveDefinitionOwners(cached.defs, directory);
  }

  // A fresh Cloud Run replica can receive a whole workspace's explorer
  // requests before the first tree read fills the cache. Share that cold
  // load: parsing every console blob once per request is CPU-bound and can
  // exhaust the service before autoscaling catches up.
  const pending = consoleDefLoads.get(workspaceId);
  if (pending && pending.sha === sha) {
    return resolveDefinitionOwners(await pending.promise, directory);
  }

  const promise = loadConsoleDefinitions(repoDir, sha);
  consoleDefLoads.set(workspaceId, { sha, promise });
  try {
    const defs = await promise;
    // Do not let an older load that finished late replace a newer sha.
    if (consoleDefLoads.get(workspaceId)?.promise === promise) {
      consoleDefCache.set(workspaceId, { sha, defs });
    }
    return resolveDefinitionOwners(defs, directory);
  } finally {
    if (consoleDefLoads.get(workspaceId)?.promise === promise) {
      consoleDefLoads.delete(workspaceId);
    }
  }
}

async function loadConsoleDefinitions(
  repoDir: string,
  sha: string,
): Promise<ConsoleDefinitionAtMain[]> {
  const entries = (await listTree(repoDir, sha)).filter(e =>
    parseConsoleRepoPath(e.path),
  );
  const sidecarPaths = entries.map(e => {
    try {
      return chartSidecarPath(e.path);
    } catch {
      return null;
    }
  });
  const toRead = [
    ...entries.map(e => e.path),
    ...sidecarPaths.filter((p): p is string => Boolean(p)),
  ];
  const blobs = await readBlobsBatch(repoDir, sha, toRead);

  const defs: ConsoleDefinitionAtMain[] = [];
  for (const entry of entries) {
    const location = parseConsoleRepoPath(entry.path);
    if (!location) continue;
    const buf = blobs.get(entry.path);
    if (!buf || isBinaryBuffer(buf)) continue;
    const parsed = parseConsoleFile(buf.toString("utf8"), location.language);
    const sidecarPath = chartSidecarPath(entry.path);
    const sidecarBuf = blobs.get(sidecarPath);
    const chartSpec =
      sidecarBuf && !isBinaryBuffer(sidecarBuf)
        ? parseChartSpec(sidecarBuf.toString("utf8"))
        : undefined;
    defs.push({
      path: entry.path,
      oid: entry.oid,
      location,
      parsed,
      chartSpec,
    });
  }

  return defs;
}

export async function readConsoleDefinitionAtMain(
  workspaceId: string,
  path: string,
): Promise<ConsoleDefinitionAtMain | null> {
  const defs = await listConsoleDefinitionsAtMain(workspaceId);
  return defs.find(d => d.path === path) ?? null;
}

async function savedIndexRows(workspaceId: string): Promise<ISavedConsole[]> {
  return SavedConsole.find({
    workspaceId: new Types.ObjectId(workspaceId),
    isSaved: true,
  });
}

function joinLiveConsoles(
  workspaceId: string,
  defs: ConsoleDefinitionAtMain[],
  rows: ISavedConsole[],
): LiveConsole[] {
  const byPath = new Map<string, ISavedConsole>();
  for (const row of rows) {
    if (row.path) byPath.set(row.path, row);
  }
  return defs.map(def => {
    const row = byPath.get(def.path) ?? null;
    return {
      ...def,
      row,
      id: row?._id ?? derivedConsoleId(workspaceId, def.path),
    };
  });
}

/**
 * Live saved consoles: files at main, overlaying the Mongo index.
 *
 * Unbound workspace → `[]` (leftover Mongo rows and leftover local git do
 * not populate the list). Git-only files appear; Mongo-only rows do not.
 * This is deliberately a pure read: reconciliation belongs to the push and
 * webhook paths, never a request that can be fanned out by realtime clients.
 */
export async function loadLiveConsoles(
  workspaceId: string,
): Promise<LiveConsole[]> {
  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return [];
  const [defs, rows] = await Promise.all([
    listConsoleDefinitionsAtMain(workspaceId),
    savedIndexRows(workspaceId),
  ]);
  return joinLiveConsoles(workspaceId, defs, rows);
}

/**
 * The code to EXECUTE for a console: the file at main when the console is
 * live there, else null (draft, unbound workspace, file gone). Every runner
 * — the execute route, the scheduled executor, the agent's load — used to
 * run `SavedConsole.code`, i.e. the last push, so a query edited in git ran
 * stale until the webhook landed.
 */
export async function liveConsoleCode(
  workspaceId: string,
  consoleId: string,
): Promise<{ code: string; language: ConsoleLanguage; path: string } | null> {
  const hit = await loadLiveConsoleById(workspaceId, consoleId);
  if (!hit || !("live" in hit)) return null;
  return {
    code: hit.live.parsed.code,
    language: hit.live.location.language,
    path: hit.live.path,
  };
}

/**
 * Resolve a console id for GET. Drafts stay on the Mongo working copy;
 * saved consoles are live only when the file exists at main.
 */
export async function loadLiveConsoleById(
  workspaceId: string,
  consoleId: string,
): Promise<{ draft: ISavedConsole } | { live: LiveConsole } | null> {
  if (!Types.ObjectId.isValid(consoleId)) return null;
  const row = await SavedConsole.findOne({
    _id: new Types.ObjectId(consoleId),
    workspaceId: new Types.ObjectId(workspaceId),
  });
  if (row && row.isSaved === false) return { draft: row };

  const repoDir = await boundRepoDirIfExists(workspaceId);
  if (repoDir == null) return null;

  if (row?.path) {
    const def = await readConsoleDefinitionAtMain(workspaceId, row.path);
    if (!def) return null;
    return { live: { ...def, row, id: row._id } };
  }

  const live = await loadLiveConsoles(workspaceId);
  const match = live.find(item => item.id.toString() === consoleId);
  return match ? { live: match } : null;
}

/**
 * Box state — what the sandbox says about itself, relayed live.
 *
 * Every other read of sandbox state is a pull on a timer: the client polls,
 * the API execs into the box (~1s), and the answer is as fresh as the last
 * poll. This is the push side. Processes IN the box — the dev-server
 * launcher, git hooks, the box agent — POST what changed the moment it
 * changes; the API merges it into a per-box snapshot and fans it out over
 * the workspace realtime channel, so every open tab learns in milliseconds.
 *
 * The snapshot is a CACHE, never a source of truth. It lives in Redis when
 * REDIS_URL is set (shared across API instances, like chat stream state)
 * and in process memory otherwise, and it EXPIRES: a box that stops
 * asserting its state stops being believed, and readers fall back to
 * discovery. That is what keeps this inside "the box is the truth" — the
 * cache cannot drift persistently, because nothing here survives unless the
 * machine keeps saying so.
 */
import { Redis } from "ioredis";
import { loggers } from "../logging";
import { publishRealtimeEvent } from "../services/realtime.service";
import { getSandboxProvider } from "./sandbox/provider";
import { sessionKeyFor } from "./worktree.service";
import { discoverDevServers } from "./dev-server.service";

const logger = loggers.api("apps-v2-box-state");

/** A snapshot older than this is not believed; readers rediscover. */
export const BOX_STATE_TTL_SECONDS = 90;

export type BoxChangeStatus = "added" | "modified" | "deleted" | "renamed";

export interface BoxChange {
  path: string;
  status: BoxChangeStatus;
  staged?: boolean;
  unstaged?: boolean;
}

export interface BoxDevServer {
  slug: string;
  port: number;
  /** Public origin for the browser, resolved by the API (the box cannot know it). */
  url?: string;
}

export interface BoxState {
  /** null = the box has not said yet. */
  branch: string | null;
  /** Commit the working copy is on; null = unknown. */
  head: string | null;
  /** Commits ahead of the tracked upstream; null = unknown. */
  ahead: number | null;
  /** Repo-wide uncommitted changes; null = unknown. */
  changes: BoxChange[] | null;
  /** Dev servers serving right now; null = unknown. */
  devServers: BoxDevServer[] | null;
  /** Server receipt time of the newest patch (ms). */
  updatedAt: number;
}

/** What a box process may send. Partial on purpose: each sender knows one thing. */
export interface BoxStatePatch {
  branch?: string;
  head?: string;
  ahead?: number;
  /** `git status --porcelain=v1` lines, or already-shaped changes. */
  changes?: Array<
    | string
    | {
        path: string;
        status?: BoxChangeStatus;
        staged?: boolean;
        unstaged?: boolean;
      }
  >;
  /** The full list (an agent snapshot) — replaces. */
  devServers?: Array<{ slug: string; port: number }>;
  /** One server's transition (the launcher) — merges. */
  devServer?: { slug: string; port: number; state: "serving" | "down" };
}

// --------------------------------------------------------------------------
// Storage: Redis when configured, else in-process with the same expiry.
// --------------------------------------------------------------------------

interface StateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttlSeconds: number): Promise<void>;
  del(key: string): Promise<void>;
}

function memoryStore(): StateStore {
  const map = new Map<string, { value: string; expiresAt: number }>();
  return {
    async get(key) {
      const hit = map.get(key);
      if (!hit) return null;
      if (hit.expiresAt <= Date.now()) {
        map.delete(key);
        return null;
      }
      return hit.value;
    },
    async set(key, value, ttlSeconds) {
      map.set(key, { value, expiresAt: Date.now() + ttlSeconds * 1000 });
    },
    async del(key) {
      map.delete(key);
    },
  };
}

function redisStore(url: string): StateStore {
  const redis = new Redis(url, { maxRetriesPerRequest: 2 });
  redis.on("error", error =>
    logger.warn("Apps v2 box-state redis error", {
      error: error instanceof Error ? error.message : String(error),
    }),
  );
  return {
    get: key => redis.get(key),
    async set(key, value, ttlSeconds) {
      await redis.set(key, value, "EX", ttlSeconds);
    },
    async del(key) {
      await redis.del(key);
    },
  };
}

let store: StateStore | null = null;
function getStore(): StateStore {
  if (!store) {
    store = process.env.REDIS_URL
      ? redisStore(process.env.REDIS_URL)
      : memoryStore();
  }
  return store;
}

/** Test seam: drop the store so the next call rebuilds it (memory mode). */
export function resetBoxStateStoreForTests(): void {
  store = null;
}

function keyFor(sessionKey: string): string {
  return `apps-v2:box-state:${sessionKey}`;
}

// --------------------------------------------------------------------------
// Reads
// --------------------------------------------------------------------------

export async function getBoxState(
  sessionKey: string,
): Promise<BoxState | null> {
  try {
    const raw = await getStore().get(keyFor(sessionKey));
    return raw ? (JSON.parse(raw) as BoxState) : null;
  } catch (error) {
    logger.warn("Apps v2 box-state read failed", {
      sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

/** A snapshot that can answer git status without touching the box. */
export function hasGitState(
  state: BoxState | null,
): state is BoxState & { branch: string; changes: BoxChange[] } {
  return (
    !!state && typeof state.branch === "string" && Array.isArray(state.changes)
  );
}

/** The box is gone (recycled, destroyed): nothing it said still holds. */
export async function forgetBoxState(sessionKey: string): Promise<void> {
  await getStore()
    .del(keyFor(sessionKey))
    .catch(() => undefined);
}

// --------------------------------------------------------------------------
// Writes
// --------------------------------------------------------------------------

/** `XY path` from --porcelain=v1 (renames: `R  old -> new`). */
function parsePorcelain(line: string): BoxChange | null {
  if (line.length < 4) return null;
  const xy = line.slice(0, 2);
  let path = line.slice(3);
  const arrow = path.indexOf(" -> ");
  if (arrow !== -1) path = path.slice(arrow + 4);
  let status: BoxChangeStatus = "modified";
  if (xy === "??" || xy.includes("A")) status = "added";
  else if (xy.includes("D")) status = "deleted";
  else if (xy.includes("R")) status = "renamed";
  return {
    path,
    status,
    staged: xy[0] !== " " && xy[0] !== "?",
    unstaged: xy === "??" || xy[1] !== " ",
  };
}

function shapeChanges(
  input: Array<
    | string
    | {
        path: string;
        status?: BoxChangeStatus;
        staged?: boolean;
        unstaged?: boolean;
      }
  >,
): BoxChange[] {
  const out: BoxChange[] = [];
  for (const item of input) {
    if (typeof item === "string") {
      const parsed = parsePorcelain(item);
      if (parsed) out.push(parsed);
    } else if (item && typeof item.path === "string") {
      out.push({
        path: item.path,
        status: item.status ?? "modified",
        staged: item.staged,
        unstaged: item.unstaged,
      });
    }
  }
  return out;
}

function applyPatch(prev: BoxState | null, patch: BoxStatePatch): BoxState {
  const next: BoxState = prev
    ? { ...prev, devServers: prev.devServers ? [...prev.devServers] : null }
    : {
        branch: null,
        head: null,
        ahead: null,
        changes: null,
        devServers: null,
        updatedAt: 0,
      };
  if (typeof patch.branch === "string") next.branch = patch.branch;
  if (typeof patch.head === "string") next.head = patch.head;
  if (Number.isInteger(patch.ahead)) next.ahead = patch.ahead as number;
  if (Array.isArray(patch.changes)) next.changes = shapeChanges(patch.changes);
  if (Array.isArray(patch.devServers)) {
    // A full list replaces — but keep already-resolved urls for servers that
    // are still there on the same port, so a heartbeat does not cost a
    // provider lookup per server.
    const known = new Map(
      (prev?.devServers ?? []).map(d => [`${d.slug}:${d.port}`, d.url]),
    );
    next.devServers = patch.devServers
      .filter(d => d && typeof d.slug === "string" && Number.isInteger(d.port))
      .map(d => ({
        slug: d.slug,
        port: d.port,
        url: known.get(`${d.slug}:${d.port}`),
      }));
  }
  if (patch.devServer && typeof patch.devServer.slug === "string") {
    const { slug, port, state } = patch.devServer;
    const list = (next.devServers ?? []).filter(d => d.slug !== slug);
    if (state === "serving" && Number.isInteger(port)) {
      const previous = (next.devServers ?? []).find(d => d.slug === slug);
      list.push({
        slug,
        port,
        url: previous?.port === port ? previous.url : undefined,
      });
    }
    next.devServers = list;
  }
  next.updatedAt = Date.now();
  return next;
}

/**
 * Merge what a box process reported, persist with expiry, and tell every
 * open tab. Returns the merged snapshot.
 */
export async function patchBoxState(input: {
  workspaceId: string;
  userId: string;
  patch: BoxStatePatch;
  source: string;
}): Promise<BoxState> {
  const { workspaceId, userId, patch, source } = input;
  const sessionKey = sessionKeyFor(workspaceId, userId);
  let prev = await getBoxState(sessionKey);

  // A delta on a COLD snapshot must not pose as the full list: with nothing
  // known yet, "hello-world is serving" would read as "only hello-world is
  // serving" and mark every other running server down. Seed the list by
  // discovery once (one exec); the box agent keeps it warm from then on.
  if (patch.devServer && prev?.devServers == null) {
    try {
      const discovered = await discoverDevServers({ sessionKey });
      prev = applyPatch(prev, { devServers: discovered });
    } catch (error) {
      logger.warn("Apps v2 box-state could not seed dev servers", {
        sessionKey,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  const next = applyPatch(prev, patch);

  // The browser iframes a public origin the box cannot know about itself.
  if (next.devServers) {
    const provider = getSandboxProvider();
    for (const server of next.devServers) {
      if (server.url) continue;
      try {
        server.url = await provider.publicUrlForPort(
          { sessionKey },
          server.port,
        );
      } catch (error) {
        logger.warn("Apps v2 box-state could not resolve a dev-server url", {
          sessionKey,
          slug: server.slug,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  try {
    await getStore().set(
      keyFor(sessionKey),
      JSON.stringify(next),
      BOX_STATE_TTL_SECONDS,
    );
  } catch (error) {
    logger.warn("Apps v2 box-state write failed", {
      sessionKey,
      error: error instanceof Error ? error.message : String(error),
    });
  }

  logger.debug("Apps v2 box-state patched", {
    sessionKey,
    source,
    branch: next.branch,
    changes: next.changes?.length,
    devServers: next.devServers?.map(d => `${d.slug}:${d.port}`),
  });
  publishRealtimeEvent(workspaceId, {
    type: "app-v2.box-state",
    userId,
    state: next,
  });
  return next;
}

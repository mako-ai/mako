/**
 * Warm dbt working directories.
 *
 * dbt-core is a filesystem tool, so every command must run against a real
 * project directory. Instead of materializing a throwaway temp dir per command
 * (cold parse + re-materialize every time), we keep a STABLE directory per
 * (workspace, project, environment, role) and reuse it across runs. That keeps
 * `target/partial_parse.msgpack` and `dbt_packages/` warm on the instance, so
 * dbt re-parses only changed files and skips `dbt deps` — the same trick the
 * dbt Cloud "develop" session uses, adapted to our single-container deploy.
 *
 * Roles isolate workloads so a long deploy build never blocks an interactive
 * compile on the same project: "adhoc" (parse/compile/show from the IDE +
 * agent) and "run" (the Inngest executor) get separate warm dirs.
 *
 * Access to a given dir is serialized by an in-process async mutex. Within one
 * process (local dev runs the executor in the API process) this prevents two
 * commands from corrupting the same dir. In production the executor and API
 * are separate containers with separate disks, and the executor is already
 * concurrency=1 per project, so the mutex is sufficient.
 *
 * Cloud Run instances are ephemeral (their /tmp is cleared on recycle), so
 * warm dirs self-bound across deploys; a cold instance simply warms on first
 * use (optionally seeded from the artifact-store cache).
 */

import { mkdir, readdir, rm, stat, utimes } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { loggers } from "../logging";

const logger = loggers.app();

const WARM_ROOT =
  process.env.DBT_WARM_DIR_ROOT ?? join(tmpdir(), "mako-dbt-warm");

/**
 * Bound how much warm state accumulates per instance. Warm dirs live in /tmp
 * (tmpfs on Cloud Run, so RAM-backed), and nothing else deletes them, so a
 * long-lived instance would otherwise grow a dir per project it ever served.
 */
const MAX_WARM_DIRS = Number(process.env.DBT_WARM_DIR_MAX ?? "40");
/** Idle warm dirs untouched for longer than this are reaped (default 24h). */
const WARM_DIR_TTL_MS = Number(
  process.env.DBT_WARM_DIR_TTL_MS ?? String(24 * 60 * 60 * 1000),
);
/** Minimum gap between opportunistic sweeps within one process. */
const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
let lastSweepAt = 0;

/** Escape hatch: set DBT_DISABLE_WARM_DIR=true to force throwaway temp dirs. */
export function warmDirsEnabled(): boolean {
  return process.env.DBT_DISABLE_WARM_DIR !== "true";
}

export type DbtDirRole = "adhoc" | "run";

export interface ProjectDirScope {
  workspaceId: string;
  projectId: string;
  environment: string;
  role: DbtDirRole;
}

function sanitize(value: string): string {
  return value.replace(/[^\w.-]/g, "_");
}

function dirFor(scope: ProjectDirScope): string {
  return join(
    WARM_ROOT,
    sanitize(scope.workspaceId),
    sanitize(scope.projectId),
    `${sanitize(scope.environment)}__${scope.role}`,
  );
}

// Per-dir promise chain: each acquirer waits on the previous holder's release.
const locks = new Map<string, Promise<void>>();

/** Enumerate warm leaf dirs (WARM_ROOT/<ws>/<project>/<env__role>) + mtime. */
async function listWarmLeafDirs(): Promise<
  Array<{ dir: string; mtimeMs: number }>
> {
  const leaves: Array<{ dir: string; mtimeMs: number }> = [];
  let workspaces: string[];
  try {
    workspaces = await readdir(WARM_ROOT);
  } catch {
    return leaves; // root not created yet
  }
  for (const ws of workspaces) {
    let projects: string[];
    try {
      projects = await readdir(join(WARM_ROOT, ws));
    } catch {
      continue;
    }
    for (const proj of projects) {
      const projDir = join(WARM_ROOT, ws, proj);
      let envs: string[];
      try {
        envs = await readdir(projDir);
      } catch {
        continue;
      }
      for (const env of envs) {
        const dir = join(projDir, env);
        try {
          const s = await stat(dir);
          if (s.isDirectory()) leaves.push({ dir, mtimeMs: s.mtimeMs });
        } catch {
          // raced removal — ignore
        }
      }
    }
  }
  return leaves;
}

/**
 * Best-effort, throttled reaping of idle warm dirs so tmpfs can't grow
 * unbounded on a long-lived instance. Evicts by TTL and a count cap (LRU).
 * Never touches a dir that currently holds a lock (an in-flight command), so
 * it can't corrupt a live run; idle dirs only lose a re-warmable cache.
 */
async function maybeSweepWarmDirs(): Promise<void> {
  const now = Date.now();
  if (now - lastSweepAt < SWEEP_INTERVAL_MS) return;
  lastSweepAt = now;

  try {
    const idle = (await listWarmLeafDirs())
      .filter(l => !locks.has(l.dir))
      .sort((a, b) => a.mtimeMs - b.mtimeMs); // oldest first

    const toRemove = new Set<string>();
    const overflow = Math.max(0, idle.length - MAX_WARM_DIRS);
    idle.slice(0, overflow).forEach(l => toRemove.add(l.dir)); // count cap
    for (const l of idle) {
      if (now - l.mtimeMs > WARM_DIR_TTL_MS) toRemove.add(l.dir); // ttl
    }

    let removed = 0;
    for (const dir of toRemove) {
      if (locks.has(dir)) continue; // re-check immediately before removal
      await rm(dir, { recursive: true, force: true });
      removed += 1;
    }
    if (removed > 0) {
      logger.debug("Reaped idle dbt warm dirs", { removed });
    }
  } catch (error) {
    logger.warn("dbt warm-dir sweep failed", { error: String(error) });
  }
}

/**
 * Run `fn` with exclusive access to the project's warm directory. Serializes
 * concurrent callers for the same dir within this process.
 */
export async function withProjectDir<T>(
  scope: ProjectDirScope,
  fn: (dir: string) => Promise<T>,
): Promise<T> {
  const dir = dirFor(scope);

  const previous = locks.get(dir) ?? Promise.resolve();
  let release: () => void = () => {};
  const gate = new Promise<void>(resolve => {
    release = resolve;
  });
  const chained = previous.then(() => gate);
  locks.set(dir, chained);

  await previous;
  try {
    await mkdir(dir, { recursive: true });
    // Touch mtime so the count-cap LRU reflects "last acquired", not just
    // last dbt write, then opportunistically reap other idle dirs.
    await utimes(dir, new Date(), new Date()).catch(() => {});
    void maybeSweepWarmDirs();
    return await fn(dir);
  } finally {
    release();
    // Drop the entry if no one chained after us, to bound the map.
    if (locks.get(dir) === chained) locks.delete(dir);
  }
}

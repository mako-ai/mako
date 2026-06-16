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

import { mkdir } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";

const WARM_ROOT =
  process.env.DBT_WARM_DIR_ROOT ?? join(tmpdir(), "mako-dbt-warm");

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
    return await fn(dir);
  } finally {
    release();
    // Drop the entry if no one chained after us, to bound the map.
    if (locks.get(dir) === chained) locks.delete(dir);
  }
}

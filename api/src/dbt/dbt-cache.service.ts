/**
 * dbt run cache — cross-run/cross-instance warm state stored in the artifact
 * store so each dbt invocation doesn't start cold.
 *
 * Two caches, both BEST-EFFORT (any failure falls back to correct cold
 * behavior — dbt validates its own partial-parse cache against file checksums
 * and re-parses on any mismatch, so a stale/garbage cache never produces a
 * wrong result):
 *
 *   1. partial_parse.msgpack — dbt's internal parse manifest. Seeding it into
 *      target/ lets dbt re-parse only changed files instead of the whole
 *      project (~seconds → <1s on non-trivial projects). Keyed per
 *      (workspace, project, environment) because env_var rendering can affect
 *      the parsed manifest.
 *   2. dbt_packages/ (+ package-lock.yml) — the installed packages tree.
 *      Caching it lets us skip `dbt deps` (git/registry downloads) when
 *      packages.yml is unchanged. Keyed per (workspace, project) and validated
 *      with a hash of the dependency declarations.
 *
 * Keys live under `dbt-cache/` so they never collide with per-run artifacts
 * (`dbt-artifacts/`).
 */

import crypto from "crypto";
import { getDashboardArtifactStore } from "../services/dashboard-artifact-store.service";
import { loggers } from "../logging";

const logger = loggers.app();

export interface DbtCacheScope {
  workspaceId: string;
  projectId: string;
  environment: string;
}

type ProjectFile = { path: string; content: string };

function sanitizeSegment(value: string): string {
  return value.replace(/[^\w.-]/g, "_");
}

function parsePrefix(scope: DbtCacheScope): string {
  return `dbt-cache/${scope.workspaceId}/${scope.projectId}/${sanitizeSegment(scope.environment)}`;
}

function packagesPrefix(scope: DbtCacheScope): string {
  // Packages depend only on packages.yml/dependencies.yml, not on the
  // environment — share one cache across a project's environments.
  return `dbt-cache/${scope.workspaceId}/${scope.projectId}`;
}

const PARTIAL_PARSE_FILE = "partial_parse.msgpack";

/**
 * sha256 of the dependency declarations, or null when the project declares no
 * real packages (only comments / no file). Used to detect when the cached
 * dbt_packages/ tree is still valid.
 */
export function computePackagesHash(files: ProjectFile[]): string | null {
  const declarations = ["packages.yml", "dependencies.yml"]
    .map(name => {
      const file = files.find(candidate => candidate.path === name);
      return file ? `${name}:${file.content}` : "";
    })
    .join("\n");

  const hasRealPackages = declarations
    .split("\n")
    .map(line => line.trim())
    .some(
      line =>
        line.length > 0 &&
        !line.startsWith("#") &&
        !line.endsWith(":") &&
        line !== "packages.yml" &&
        line !== "dependencies.yml",
    );
  if (!hasRealPackages) return null;

  return crypto.createHash("sha256").update(declarations).digest("hex");
}

async function readKey(key: string): Promise<Buffer | undefined> {
  try {
    const stream = await getDashboardArtifactStore().openReadStream(key);
    if (!stream) return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return chunks.length > 0 ? Buffer.concat(chunks) : undefined;
  } catch {
    // Missing key (cold cache) or transient store error — treat as a miss.
    return undefined;
  }
}

export interface LoadedDbtCaches {
  /** Seed into target/partial_parse.msgpack to warm parsing. */
  partialParse?: Buffer;
  /** tgz of dbt_packages/ (+ package-lock.yml) to seed when packages match. */
  packages?: Buffer;
  /** True when the cached packages tree matches the current declarations. */
  packagesFresh: boolean;
}

export async function loadDbtCaches(
  scope: DbtCacheScope,
  packagesHash: string | null,
): Promise<LoadedDbtCaches> {
  const partialParseKey = `${parsePrefix(scope)}/${PARTIAL_PARSE_FILE}`;
  const hashKey = `${packagesPrefix(scope)}/packages_hash.txt`;

  const [partialParse, cachedHashBuf] = await Promise.all([
    readKey(partialParseKey),
    packagesHash ? readKey(hashKey) : Promise.resolve(undefined),
  ]);

  const cachedHash = cachedHashBuf?.toString("utf8").trim();
  const packagesFresh = Boolean(packagesHash) && cachedHash === packagesHash;
  const packages = packagesFresh
    ? await readKey(`${packagesPrefix(scope)}/dbt_packages.tgz`)
    : undefined;

  return { partialParse, packages, packagesFresh: Boolean(packages) };
}

export async function saveParseCache(
  scope: DbtCacheScope,
  partialParse: Buffer,
): Promise<void> {
  try {
    await getDashboardArtifactStore().putBuffer(
      partialParse,
      `${parsePrefix(scope)}/${PARTIAL_PARSE_FILE}`,
      "application/octet-stream",
    );
  } catch (error) {
    logger.warn("Failed to save dbt partial-parse cache", {
      error,
      projectId: scope.projectId,
      environment: scope.environment,
    });
  }
}

export async function savePackagesCache(
  scope: DbtCacheScope,
  archive: Buffer,
  packagesHash: string,
): Promise<void> {
  try {
    const store = getDashboardArtifactStore();
    await store.putBuffer(
      archive,
      `${packagesPrefix(scope)}/dbt_packages.tgz`,
      "application/gzip",
    );
    await store.putBuffer(
      Buffer.from(packagesHash, "utf8"),
      `${packagesPrefix(scope)}/packages_hash.txt`,
      "text/plain",
    );
  } catch (error) {
    logger.warn("Failed to save dbt packages cache", {
      error,
      projectId: scope.projectId,
    });
  }
}

/**
 * dbt runner — materializes a project snapshot to a temp dir and executes
 * dbt commands as a subprocess with JSON log streaming.
 *
 * Security: credentials are passed only through the child-process env
 * (profiles.yml references {{ env_var(...) }}); file paths are validated
 * against traversal; commands are pre-validated by commands.ts.
 */

import { spawn } from "child_process";
import {
  access,
  mkdtemp,
  mkdir,
  readFile,
  readdir,
  rm,
  writeFile,
} from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, normalize, relative, sep } from "path";
import { loggers } from "../logging";
import type { ParsedDbtCommand } from "./commands";
import type { RenderedProfile } from "./adapter-map";
import { resolveDbtBin } from "./dbt-bin";

const logger = loggers.app();

export interface DbtLogLine {
  ts: Date;
  level: string;
  line: string;
}

export interface DbtRunRequest {
  files: Array<{ path: string; content: string }>;
  profile: RenderedProfile;
  commands: ParsedDbtCommand[];
  dbtVersion?: string;
  /** Per-command timeout (ms). Defaults to 9 minutes (Cloud Run is 600s). */
  commandTimeoutMs?: number;
  /**
   * Artifacts to seed into target/ before commands run. Used by retry-from-
   * failure: `dbt retry` reads target/run_results.json to resume at the
   * failed/skipped nodes.
   */
  restoreTarget?: {
    runResults?: Buffer;
    manifest?: Buffer;
  };
  /**
   * Prod manifest.json for Slim CI. When set, commands run with
   * `--defer --state <dir>` so unselected refs resolve to prod and
   * `--select state:modified+` only builds what changed.
   */
  deferState?: Buffer;
  /**
   * dbt's partial-parse manifest from a previous run. Seeded into
   * target/partial_parse.msgpack so dbt re-parses only changed files. dbt
   * validates it against file checksums + config and full-parses on mismatch,
   * so a stale buffer is always safe.
   */
  seedPartialParse?: Buffer;
  /**
   * tgz of a previously-installed dbt_packages/ (+ package-lock.yml). Extracted
   * into the project dir before commands so `dbt deps` can be skipped.
   */
  seedPackagesArchive?: Buffer;
  /**
   * Skip `dbt deps` (used together with seedPackagesArchive when the cached
   * packages tree is still valid for the current packages.yml).
   */
  skipDeps?: boolean;
  /**
   * Reuse a stable warm directory instead of a throwaway temp dir. The caller
   * owns its lifecycle (serialization + eviction); runDbt syncs files in place
   * (write-if-changed + delete reconciliation) and does NOT delete it on exit.
   */
  workingDir?: string;
  /**
   * Hash of the dependency declarations. With a warm `workingDir`, lets runDbt
   * skip `dbt deps` when the on-disk dbt_packages/ tree already matches.
   */
  packagesHash?: string | null;
  signal?: AbortSignal;
  onLog?: (line: DbtLogLine) => void;
}

export interface RunResultsArtifact {
  results: Array<{
    unique_id: string;
    status: string;
    execution_time: number;
    message?: string | null;
    adapter_response?: { rows_affected?: number };
  }>;
  elapsed_time?: number;
}

export interface DbtCommandResult {
  command: string;
  exitCode: number;
  logLines: DbtLogLine[];
  runResults?: RunResultsArtifact;
}

export interface DbtRunResult {
  success: boolean;
  commandResults: DbtCommandResult[];
  /** Raw artifact contents collected from target/ after the last command. */
  artifacts: {
    manifest?: Buffer;
    runResults?: Buffer;
    catalog?: Buffer;
    /** Written by `dbt source freshness`. */
    sources?: Buffer;
    /** dbt's partial-parse manifest — cache for the next run's parse. */
    partialParse?: Buffer;
    /** tgz of dbt_packages/ — only present when `dbt deps` ran this command. */
    packagesArchive?: Buffer;
  };
}

/**
 * True when the project declares at least one dbt package (ignoring the
 * commented scaffold). Drives whether we run `dbt deps` before commands.
 */
function projectHasPackages(
  files: Array<{ path: string; content: string }>,
): boolean {
  const pkg = files.find(
    file => file.path === "packages.yml" || file.path === "dependencies.yml",
  );
  if (!pkg) return false;
  return pkg.content
    .split("\n")
    .map(line => line.trim())
    .some(line => line.length > 0 && !line.startsWith("#"));
}

function ensureSafeRelativePath(path: string): string {
  const normalized = normalize(path).replace(/\\/g, "/");
  if (
    !normalized ||
    normalized.startsWith("/") ||
    normalized.startsWith("..") ||
    normalized.split("/").includes("..")
  ) {
    throw new Error(`Invalid dbt file path: ${path}`);
  }
  return normalized;
}

interface DbtJsonLogEvent {
  info?: {
    ts?: string;
    level?: string;
    msg?: string;
  };
}

function parseLogLine(raw: string): DbtLogLine {
  try {
    const event = JSON.parse(raw) as DbtJsonLogEvent;
    if (event.info) {
      return {
        ts: event.info.ts ? new Date(event.info.ts) : new Date(),
        level: event.info.level ?? "info",
        line: event.info.msg ?? raw,
      };
    }
  } catch {
    // Non-JSON output (e.g. tracebacks) — keep the raw line.
  }
  return { ts: new Date(), level: "info", line: raw };
}

async function readArtifact(
  projectDir: string,
  name: string,
): Promise<Buffer | undefined> {
  try {
    return await readFile(join(projectDir, "target", name));
  } catch {
    return undefined;
  }
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

/** Run `tar` as a subprocess; rejects on non-zero exit. */
function runTar(args: string[], cwd: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn("tar", args, {
      cwd,
      stdio: ["ignore", "ignore", "pipe"],
    });
    let stderr = "";
    child.stderr.on("data", (data: Buffer) => {
      stderr += data.toString("utf8");
    });
    child.on("error", reject);
    child.on("close", code => {
      if (code === 0) resolve();
      else reject(new Error(`tar exited ${code}: ${stderr.slice(0, 500)}`));
    });
  });
}

/** gzip-tar the given entries (those that exist) under projectDir into a Buffer. */
async function archiveEntries(
  projectDir: string,
  entries: string[],
): Promise<Buffer | undefined> {
  const present: string[] = [];
  for (const entry of entries) {
    if (await pathExists(join(projectDir, entry))) present.push(entry);
  }
  if (present.length === 0) return undefined;
  const tarPath = join(projectDir, ".mako-cache-out.tgz");
  try {
    await runTar(["-czf", tarPath, ...present], projectDir);
    return await readFile(tarPath);
  } catch (error) {
    logger.warn("Failed to archive dbt cache entries", {
      error: String(error),
    });
    return undefined;
  } finally {
    await rm(tarPath, { force: true }).catch(() => {});
  }
}

/** Extract a gzip-tar buffer into projectDir. Best-effort. */
async function extractArchive(
  buffer: Buffer,
  projectDir: string,
): Promise<void> {
  const tarPath = join(projectDir, ".mako-cache-in.tgz");
  try {
    await writeFile(tarPath, buffer);
    await runTar(["-xzf", tarPath], projectDir);
  } finally {
    await rm(tarPath, { force: true }).catch(() => {});
  }
}

/** Write only when content differs — avoids needless mtime bumps that would
 * defeat dbt's checksum-based partial parsing in a warm dir. */
async function writeFileIfChanged(
  absolute: string,
  content: string,
  mode?: number,
): Promise<void> {
  try {
    const existing = await readFile(absolute, "utf8");
    if (existing === content) return;
  } catch {
    // Missing — fall through to write.
  }
  await mkdir(dirname(absolute), { recursive: true });
  await writeFile(
    absolute,
    content,
    mode ? { encoding: "utf8", mode } : "utf8",
  );
}

// Top-level entries dbt (or we) own — never pruned during reconciliation.
const RECONCILE_PRESERVED_DIRS = new Set([
  "target",
  "dbt_packages",
  "logs",
  "state",
]);
const RECONCILE_PRESERVED_FILES = new Set(["profiles.yml", "package-lock.yml"]);

async function listFilesRecursive(
  root: string,
  current: string,
  out: string[],
): Promise<void> {
  let entries;
  try {
    entries = await readdir(current, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    const abs = join(current, entry.name);
    const rel = relative(root, abs).split(sep).join("/");
    const top = rel.split("/")[0];
    if (RECONCILE_PRESERVED_DIRS.has(top)) continue;
    if (entry.isDirectory()) {
      await listFilesRecursive(root, abs, out);
    } else if (entry.isFile()) {
      out.push(rel);
    }
  }
}

/**
 * Delete files in a warm dir that are no longer part of the project snapshot
 * (e.g. a model the user deleted), so a stale file can never be built. Keeps
 * dbt-owned dirs, profiles.yml, keyfiles, and our dotfiles.
 */
async function reconcileWarmDir(
  projectDir: string,
  keep: Set<string>,
): Promise<void> {
  const present: string[] = [];
  await listFilesRecursive(projectDir, projectDir, present);
  for (const rel of present) {
    if (keep.has(rel)) continue;
    if (RECONCILE_PRESERVED_FILES.has(rel)) continue;
    if (rel.startsWith(".")) continue; // our markers / cache scratch
    await rm(join(projectDir, ...rel.split("/")), { force: true }).catch(
      () => {},
    );
  }
}

function execDbtCommand(params: {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  timeoutMs: number;
  signal?: AbortSignal;
  onLog: (line: DbtLogLine) => void;
}): Promise<number> {
  return new Promise((resolve, reject) => {
    const child = spawn(params.bin, params.args, {
      cwd: params.cwd,
      env: params.env,
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdoutBuffer = "";
    let settled = false;

    const timeout = setTimeout(() => {
      params.onLog({
        ts: new Date(),
        level: "error",
        line: `Command timed out after ${Math.round(params.timeoutMs / 1000)}s — sending SIGTERM`,
      });
      child.kill("SIGTERM");
    }, params.timeoutMs);

    const onAbort = () => child.kill("SIGTERM");
    params.signal?.addEventListener("abort", onAbort, { once: true });

    const flushLines = (chunk: string, isStderr: boolean) => {
      if (isStderr) {
        for (const line of chunk.split("\n")) {
          if (line.trim()) {
            params.onLog({ ts: new Date(), level: "error", line });
          }
        }
        return;
      }
      stdoutBuffer += chunk;
      let newlineIdx = stdoutBuffer.indexOf("\n");
      while (newlineIdx >= 0) {
        const raw = stdoutBuffer.slice(0, newlineIdx).trim();
        stdoutBuffer = stdoutBuffer.slice(newlineIdx + 1);
        if (raw) params.onLog(parseLogLine(raw));
        newlineIdx = stdoutBuffer.indexOf("\n");
      }
    };

    child.stdout.on("data", (data: Buffer) =>
      flushLines(data.toString("utf8"), false),
    );
    child.stderr.on("data", (data: Buffer) =>
      flushLines(data.toString("utf8"), true),
    );

    child.on("error", error => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      reject(error);
    });

    child.on("close", code => {
      if (settled) return;
      settled = true;
      clearTimeout(timeout);
      params.signal?.removeEventListener("abort", onAbort);
      if (stdoutBuffer.trim()) params.onLog(parseLogLine(stdoutBuffer.trim()));
      resolve(code ?? 1);
    });
  });
}

/**
 * Sync a dbt project onto disk: project files + profiles.yml + credential
 * keyfiles (0600). Writes only changed files (so warm dirs keep dbt's
 * checksum-based partial parsing valid) and, when `reconcile` is set, prunes
 * files no longer in the snapshot so a deleted model can never be built.
 *
 * Returns the keyfile env map (absolute paths the profile's env_var()
 * references resolve to). Shared by {@link runDbt} (subprocess) and the
 * resident engine's prepare so both operate on an identical tree.
 */
export async function materializeDbtProject(
  projectDir: string,
  params: {
    files: Array<{ path: string; content: string }>;
    profile: RenderedProfile;
    reconcile?: boolean;
  },
): Promise<{ keyfileEnv: Record<string, string> }> {
  // Preserve list for reconciliation (profiles.yml + every snapshot file +
  // keyfiles get added below).
  const keep = new Set<string>(["profiles.yml"]);

  for (const file of params.files) {
    const safePath = ensureSafeRelativePath(file.path);
    keep.add(safePath);
    await writeFileIfChanged(
      join(projectDir, ...safePath.split("/")),
      file.content,
    );
  }
  await writeFileIfChanged(
    join(projectDir, "profiles.yml"),
    params.profile.profilesYml,
  );

  // Credential files (e.g. BigQuery service-account JSON) with restrictive
  // perms; their absolute paths are exported so env_var() keyfile refs resolve.
  const keyfileEnv: Record<string, string> = {};
  for (const keyfile of params.profile.keyfiles ?? []) {
    const safePath = ensureSafeRelativePath(keyfile.filename);
    keep.add(safePath);
    const absolute = join(projectDir, ...safePath.split("/"));
    await writeFileIfChanged(absolute, keyfile.content, 0o600);
    keyfileEnv[keyfile.envVar] = absolute;
  }

  if (params.reconcile) await reconcileWarmDir(projectDir, keep);
  return { keyfileEnv };
}

/**
 * Seed artifact-store caches into a cold project dir so the resident engine's
 * first parse is incremental (partial-parse manifest) and package-aware
 * (dbt_packages/ present, so `dbt parse` resolves package macros without a
 * `dbt deps` install). No-op when the dir already has fresher on-disk state.
 */
export async function seedDbtCaches(
  projectDir: string,
  caches: { partialParse?: Buffer; packagesArchive?: Buffer },
): Promise<void> {
  if (caches.partialParse) {
    const pp = join(projectDir, "target", "partial_parse.msgpack");
    if (!(await pathExists(pp))) {
      await mkdir(join(projectDir, "target"), { recursive: true });
      await writeFile(pp, caches.partialParse).catch(() => {});
    }
  }
  if (
    caches.packagesArchive &&
    !(await pathExists(join(projectDir, "dbt_packages")))
  ) {
    await extractArchive(caches.packagesArchive, projectDir).catch(() => {});
  }
}

/**
 * Materialize project files + profiles.yml into a temp dir, run each
 * pre-validated command in order (stopping at the first failure), collect
 * target/ artifacts, and always clean up the temp dir.
 */
export async function runDbt(request: DbtRunRequest): Promise<DbtRunResult> {
  // A caller-provided warm dir is reused across runs (caller owns its
  // lifecycle); otherwise use a throwaway temp dir we clean up on exit.
  const ownsDir = !request.workingDir;
  const projectDir =
    request.workingDir ?? (await mkdtemp(join(tmpdir(), "mako-dbt-")));
  const commandResults: DbtCommandResult[] = [];
  const artifacts: DbtRunResult["artifacts"] = {};

  try {
    // Sync project files + profiles.yml + keyfiles into the dir (write-if-
    // changed + delete reconciliation for warm dirs). Shared with the resident
    // engine's prepare so both see an identical on-disk tree.
    const { keyfileEnv } = await materializeDbtProject(projectDir, {
      files: request.files,
      profile: request.profile,
      reconcile: !ownsDir,
    });

    // Seed prior artifacts into target/ for `dbt retry` (run_results.json is
    // what dbt reads to resume at the failed/skipped nodes).
    if (request.restoreTarget) {
      const targetDir = join(projectDir, "target");
      await mkdir(targetDir, { recursive: true });
      if (request.restoreTarget.runResults) {
        await writeFile(
          join(targetDir, "run_results.json"),
          request.restoreTarget.runResults,
        );
      }
      if (request.restoreTarget.manifest) {
        await writeFile(
          join(targetDir, "manifest.json"),
          request.restoreTarget.manifest,
        );
      }
    }

    // Slim CI: stage the prod manifest in a state dir for `--defer --state`.
    let stateDir: string | undefined;
    if (request.deferState) {
      stateDir = join(projectDir, "state");
      await mkdir(stateDir, { recursive: true });
      await writeFile(join(stateDir, "manifest.json"), request.deferState);
    }

    // Warm dbt's parser: seed the previous run's partial-parse manifest so
    // only changed files are re-parsed. dbt self-invalidates on checksum /
    // config mismatch, so a stale buffer just triggers a full parse. In a warm
    // dir the on-disk manifest is fresher than any seed, so only seed when the
    // dir is cold (no existing manifest).
    if (request.seedPartialParse) {
      const partialParsePath = join(
        projectDir,
        "target",
        "partial_parse.msgpack",
      );
      if (!(await pathExists(partialParsePath))) {
        await mkdir(join(projectDir, "target"), { recursive: true });
        await writeFile(partialParsePath, request.seedPartialParse).catch(
          () => {},
        );
      }
    }

    const resolved = resolveDbtBin(
      request.profile.adapterPackage,
      request.dbtVersion,
    );

    const childEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...request.profile.secretEnv,
      ...keyfileEnv,
      DBT_SEND_ANONYMOUS_USAGE_STATS: "false",
      HOME: projectDir,
    };

    // Install packages first when declared. The executor runs one runDbt per
    // command, each in its own temp dir, so deps must be (re)installed here
    // before any command that depends on package macros can compile — unless
    // we can restore a cached dbt_packages/ tree and skip the network install.
    if (projectHasPackages(request.files)) {
      const packagesMarker = join(projectDir, ".mako_packages_hash");

      // Warm dir already has a matching dbt_packages/ tree → skip deps with no
      // network call and no extract.
      let warmFresh = false;
      if (!ownsDir && request.packagesHash) {
        const markerHash = await readFile(packagesMarker, "utf8")
          .then(value => value.trim())
          .catch(() => undefined);
        warmFresh =
          markerHash === request.packagesHash &&
          (await pathExists(join(projectDir, "dbt_packages")));
      }

      let packagesSeeded = false;
      if (!warmFresh && request.seedPackagesArchive) {
        try {
          await extractArchive(request.seedPackagesArchive, projectDir);
          packagesSeeded = true;
        } catch (error) {
          logger.warn("Failed to seed dbt_packages cache; running dbt deps", {
            error: String(error),
          });
        }
      }

      const skipDeps =
        warmFresh || (request.skipDeps === true && packagesSeeded);
      if (!skipDeps) {
        const depsLogLines: DbtLogLine[] = [];
        const onDepsLog = (line: DbtLogLine) => {
          depsLogLines.push(line);
          request.onLog?.(line);
        };
        onDepsLog({ ts: new Date(), level: "info", line: "$ dbt deps" });
        const depsExit = await execDbtCommand({
          bin: resolved.bin,
          args: [
            ...resolved.prefixArgs,
            "deps",
            "--profiles-dir",
            projectDir,
            "--project-dir",
            projectDir,
            "--log-format",
            "json",
            "--no-use-colors",
          ],
          cwd: projectDir,
          env: childEnv,
          timeoutMs: request.commandTimeoutMs ?? 9 * 60 * 1000,
          signal: request.signal,
          onLog: onDepsLog,
        });
        if (depsExit !== 0) {
          commandResults.push({
            command: "deps",
            exitCode: depsExit,
            logLines: depsLogLines,
            runResults: undefined,
          });
          return { success: false, commandResults, artifacts };
        }
        // Freshly installed — archive so the next run can skip the install.
        artifacts.packagesArchive = await archiveEntries(projectDir, [
          "dbt_packages",
          "package-lock.yml",
        ]);
        // Warm dir: record the hash so subsequent runs skip deps entirely.
        if (!ownsDir && request.packagesHash) {
          await writeFile(packagesMarker, request.packagesHash).catch(() => {});
        }
      }
    }

    let success = true;
    for (const command of request.commands) {
      if (request.signal?.aborted) {
        success = false;
        break;
      }

      const logLines: DbtLogLine[] = [];
      const onLog = (line: DbtLogLine) => {
        logLines.push(line);
        request.onLog?.(line);
      };

      // --defer/--state only apply to node-executing/compiling subcommands.
      const stateAware = new Set([
        "run",
        "build",
        "test",
        "compile",
        "seed",
        "snapshot",
      ]);
      const deferArgs =
        stateDir && stateAware.has(command.subcommand)
          ? ["--defer", "--state", stateDir]
          : [];

      const args = [
        ...resolved.prefixArgs,
        ...command.argv,
        ...deferArgs,
        "--profiles-dir",
        projectDir,
        "--project-dir",
        projectDir,
        "--profile",
        "mako",
        "--log-format",
        "json",
        "--no-use-colors",
      ];

      logger.info("Executing dbt command", {
        subcommand: command.subcommand,
        projectDir: projectDir.split(sep).pop(),
      });

      const exitCode = await execDbtCommand({
        bin: resolved.bin,
        args,
        cwd: projectDir,
        env: childEnv,
        timeoutMs: request.commandTimeoutMs ?? 9 * 60 * 1000,
        signal: request.signal,
        onLog,
      });

      let runResults: RunResultsArtifact | undefined;
      const runResultsRaw = await readArtifact(projectDir, "run_results.json");
      if (runResultsRaw) {
        try {
          runResults = JSON.parse(
            runResultsRaw.toString("utf8"),
          ) as RunResultsArtifact;
        } catch {
          // corrupt artifact — ignore
        }
      }

      commandResults.push({
        command: command.argv.join(" "),
        exitCode,
        logLines,
        runResults,
      });

      if (exitCode !== 0) {
        success = false;
        break;
      }
    }

    artifacts.manifest = await readArtifact(projectDir, "manifest.json");
    artifacts.runResults = await readArtifact(projectDir, "run_results.json");
    artifacts.catalog = await readArtifact(projectDir, "catalog.json");
    artifacts.sources = await readArtifact(projectDir, "sources.json");
    artifacts.partialParse = await readArtifact(
      projectDir,
      "partial_parse.msgpack",
    );

    return { success, commandResults, artifacts };
  } finally {
    // Only delete throwaway dirs. Warm dirs are owned by the caller and reused.
    if (ownsDir) {
      await rm(projectDir, { recursive: true, force: true }).catch(() => {});
    }
  }
}

/** Map a run_results.json artifact to the dbt_runs.stepResults shape. */
export function parseStepResults(
  runResults: RunResultsArtifact | undefined,
): Array<{
  uniqueId: string;
  name: string;
  resourceType: string;
  status: string;
  executionTimeMs: number;
  rowsAffected?: number;
  message?: string;
}> {
  if (!runResults?.results) return [];
  return runResults.results.map(result => {
    // unique_id format: "model.project_name.model_name" / "test.project.x.hash"
    const parts = result.unique_id.split(".");
    return {
      uniqueId: result.unique_id,
      name: parts[parts.length - 1] ?? result.unique_id,
      resourceType: parts[0] ?? "model",
      status: result.status,
      executionTimeMs: Math.round((result.execution_time ?? 0) * 1000),
      rowsAffected: result.adapter_response?.rows_affected,
      message: result.message ?? undefined,
    };
  });
}

interface SourceFreshnessResult {
  unique_id: string;
  status: string;
  max_loaded_at?: string;
  snapshotted_at?: string;
  max_loaded_at_time_ago_in_s?: number;
  execution_time?: number;
}

/**
 * Map a sources.json (`dbt source freshness`) artifact to the stepResults
 * shape so source freshness surfaces in the same run-detail table as models.
 */
export function parseSourceFreshness(sources: Buffer | undefined): Array<{
  uniqueId: string;
  name: string;
  resourceType: string;
  status: string;
  executionTimeMs: number;
  message?: string;
}> {
  if (!sources) return [];
  let parsed: { results?: SourceFreshnessResult[] };
  try {
    parsed = JSON.parse(sources.toString("utf8")) as {
      results?: SourceFreshnessResult[];
    };
  } catch {
    return [];
  }
  if (!parsed.results) return [];
  return parsed.results.map(result => {
    const parts = result.unique_id.split(".");
    const ageSeconds = result.max_loaded_at_time_ago_in_s;
    const ageLabel =
      typeof ageSeconds === "number"
        ? `loaded ${Math.round(ageSeconds / 60)}m ago`
        : undefined;
    return {
      uniqueId: result.unique_id,
      name: parts.slice(2).join(".") || result.unique_id,
      resourceType: "source",
      status: result.status,
      executionTimeMs: Math.round((result.execution_time ?? 0) * 1000),
      message: ageLabel,
    };
  });
}

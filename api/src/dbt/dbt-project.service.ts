/**
 * dbt project snapshot loading + ad-hoc execution helpers.
 *
 * Shared by the routes (compile / command endpoints), the Inngest
 * executor, and the agent's server-side verification tools so they all go
 * through identical validation: workspace scoping, environment resolution,
 * connection decryption, and command allowlisting.
 */

import { Types } from "mongoose";
import {
  DatabaseConnection,
  DbtProject,
  type IDatabaseConnection,
  type IDbtEnvironment,
  type IDbtProject,
} from "../database/workspace-schema";
import { loadRunnableWorkingTree } from "./dbt-github-sync.service";
import { renderDbtProfile, type RenderedProfile } from "./adapter-map";
import { assertAdhocDbtRunAllowed } from "./dbt-environments.service";
import { parseDbtCommand, type ParsedDbtCommand } from "./commands";
import {
  materializeDbtProject,
  parseStepResults,
  runDbt,
  seedDbtCaches,
  type DbtLogLine,
  type DbtRunResult,
} from "./runner.service";
import {
  dbtEngineEnabled,
  engineCompile,
  enginePrepare,
  engineShow,
} from "./dbt-engine.service";
import {
  computePackagesHash,
  loadDbtCaches,
  saveParseCache,
  savePackagesCache,
} from "./dbt-cache.service";
import { warmDirsEnabled, withProjectDir } from "./workspace-dir.service";
import { parseShowPreview, type DbtShowPreview } from "./show-preview";
import { loggers } from "../logging";

const logger = loggers.app();

export interface DbtProjectSnapshot {
  project: IDbtProject;
  environment: IDbtEnvironment;
  files: Array<{ path: string; content: string }>;
  profile: RenderedProfile;
}

export async function loadDbtProjectSnapshot(params: {
  workspaceId: string;
  projectId: string;
  environmentName?: string;
  /**
   * Acting user for repo-bound projects: the snapshot becomes that user's
   * working tree (their checkout branch base overlaid with their drafts).
   * Omitted → the committed base tree only (deploy/CI runs).
   */
  userId?: string;
  /** Explicit branch (CI runs building a PR head). */
  branch?: string;
}): Promise<DbtProjectSnapshot> {
  const project = await DbtProject.findOne({
    _id: new Types.ObjectId(params.projectId),
    workspaceId: new Types.ObjectId(params.workspaceId),
  });
  if (!project) {
    throw new Error("dbt project not found");
  }

  const envName = params.environmentName ?? project.defaultEnvironment;
  const environment = project.environments.find(env => env.name === envName);
  if (!environment) {
    throw new Error(
      `Environment "${envName}" not found on project "${project.name}"`,
    );
  }

  const connectionDoc = await DatabaseConnection.findOne({
    _id: environment.connectionId,
    workspaceId: project.workspaceId,
  });
  if (!connectionDoc) {
    throw new Error(
      `Connection for environment "${envName}" not found or access denied`,
    );
  }
  const connection = connectionDoc.toObject({
    getters: true,
  }) as IDatabaseConnection;

  const profile = renderDbtProfile(connection, environment);

  // Self-healing load: re-syncs a missing branch base tree (and re-anchors a
  // tracked branch that no longer exists on the remote) rather than handing
  // dbt a tree without dbt_project.yml.
  const files = await loadRunnableWorkingTree(project, {
    userId: params.userId,
    branch: params.branch,
  });

  // Environment vars (environment.vars) are injected as `--vars` by runDbt for
  // every command, so callers just forward snapshot.environment.vars.

  return { project, environment, files, profile };
}

/**
 * Read the project's last production manifest for `--defer --state`, or
 * `undefined` when no prod build exists yet. Never throws — a missing
 * manifest just disables defer for this invocation.
 */
export async function loadDbtDeferState(project: {
  lastProdManifestKey?: string;
}): Promise<Buffer | undefined> {
  const key = project.lastProdManifestKey;
  if (!key) return undefined;
  try {
    const { getDashboardArtifactStore } = await import(
      "../services/dashboard-artifact-store.service"
    );
    const stream = await getDashboardArtifactStore().openReadStream(key);
    if (!stream) return undefined;
    const chunks: Buffer[] = [];
    for await (const chunk of stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
  } catch (error) {
    logger.warn("Failed to load dbt defer state manifest", { error, key });
    return undefined;
  }
}

export interface AdhocDbtResult {
  success: boolean;
  exitCode: number;
  logs: DbtLogLine[];
  stepResults: ReturnType<typeof parseStepResults>;
  compiledSql?: string;
  /** Structured `dbt show` rows for the editor preview grid. */
  preview?: DbtShowPreview;
  raw: DbtRunResult;
}

function findCompiledSql(
  raw: DbtRunResult,
  select: string | undefined,
): string | undefined {
  if (!select || !raw.artifacts.manifest) return undefined;
  try {
    const manifest = JSON.parse(raw.artifacts.manifest.toString("utf8")) as {
      nodes?: Record<
        string,
        { name?: string; compiled_code?: string; compiled_sql?: string }
      >;
    };
    for (const node of Object.values(manifest.nodes ?? {})) {
      if (node.name === select) {
        return node.compiled_code ?? node.compiled_sql;
      }
    }
  } catch {
    // ignore parse failures — compiled SQL is best-effort
  }
  return undefined;
}

/**
 * Run an ad-hoc dbt command (compile / parse / build --select <node>) against
 * a project environment. Synchronous path used by IDE buttons + agent tools.
 */
export async function runAdhocDbtCommand(params: {
  workspaceId: string;
  projectId: string;
  environmentName?: string;
  /**
   * Acting user: repo-bound projects compile/run that user's working tree
   * (checkout branch + draft overlay) in a per-user warm dir, so one user's
   * preview never sees another user's uncommitted work.
   */
  userId?: string;
  command: string;
  /** Used to extract compiled SQL from the manifest after compile. */
  select?: string;
  /**
   * Prod manifest.json for Slim CI. When set, the command runs with
   * `--defer --state <dir>` so unselected refs resolve to the prod build.
   */
  deferState?: Buffer;
  timeoutMs?: number;
  signal?: AbortSignal;
}): Promise<AdhocDbtResult> {
  const parsed: ParsedDbtCommand = parseDbtCommand(params.command);
  const snapshot = await loadDbtProjectSnapshot({
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    environmentName: params.environmentName,
    userId: params.userId,
  });

  // Ad-hoc commands build the caller's working tree (checkout + drafts);
  // refuse warehouse writes into the protected prod-like environment —
  // deploys there go through jobs/CI, which build a committed tree.
  assertAdhocDbtRunAllowed(snapshot.project, snapshot.environment.name, [
    parsed,
  ]);

  // Warm caches so parse/compile/show/build don't re-parse the whole project
  // (and skip `dbt deps` when packages are unchanged). Best-effort. The
  // artifact cache stays per (project, environment) — a shared seed the run
  // reconciles — while the on-disk warm dir below is per user.
  const cacheScope = {
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    environment: snapshot.environment.name,
  };
  const adhocDirScope = {
    ...cacheScope,
    role: "adhoc" as const,
    userId: params.userId,
  };
  const packagesHash = computePackagesHash(snapshot.files);
  const caches = await loadDbtCaches(cacheScope, packagesHash);

  // Resident-engine fast path: offline `compile` / `show` reuse an in-memory
  // manifest (no interpreter cold start, no full re-parse) — the dbt Cloud
  // "develop" feel. Held under the same adhoc warm-dir mutex so the tree can't
  // mutate while the engine reads it. Any failure falls through to the
  // subprocess path below. Gated by DBT_ENGINE_ENABLED (default off).
  const showSelect = extractShowSelect(parsed);
  const engineSelect =
    parsed.subcommand === "compile"
      ? params.select
      : parsed.subcommand === "show"
        ? showSelect
        : undefined;
  if (
    dbtEngineEnabled() &&
    warmDirsEnabled() &&
    engineSelect &&
    (parsed.subcommand === "compile" || parsed.subcommand === "show") &&
    // The engine path does not apply --vars; skip it when the environment sets
    // vars so var() resolves correctly via the subprocess path below.
    Object.keys(snapshot.environment.vars ?? {}).length === 0
  ) {
    const select = engineSelect;
    const showLimit = extractShowLimit(parsed) ?? 100;
    try {
      const engineResult = await withProjectDir(adhocDirScope, async dir => {
        const { keyfileEnv } = await materializeDbtProject(dir, {
          files: snapshot.files,
          profile: snapshot.profile,
          reconcile: true,
        });
        await seedDbtCaches(dir, {
          partialParse: caches.partialParse,
          packagesArchive: caches.packages,
        });
        const ctx = {
          adapterPackage: snapshot.profile.adapterPackage,
          dbtVersion: snapshot.project.dbtVersion,
          connectionEnv: { ...snapshot.profile.secretEnv, ...keyfileEnv },
        };
        // Session key includes the acting user so one user's warm manifest is
        // never compiled against another user's overlay.
        const session = {
          key: `${params.workspaceId}:${params.projectId}:${snapshot.environment.name}:${params.userId ?? "shared"}`,
          projectDir: dir,
        };
        // Re-parse to pick up edits (cheap via partial parse), then reuse the
        // warm manifest to compile / show.
        await enginePrepare(ctx, session);
        if (parsed.subcommand === "show") {
          return {
            kind: "show" as const,
            result: await engineShow(ctx, session, {
              select,
              limit: showLimit,
            }),
          };
        }
        return {
          kind: "compile" as const,
          result: await engineCompile(ctx, session, select),
        };
      });
      if (engineResult.kind === "compile" && engineResult.result.ok) {
        logger.info("dbt engine compile hit", {
          event: "dbt_engine_compile",
          outcome: "hit",
          elapsedMs: engineResult.result.elapsed_ms,
          projectId: cacheScope.projectId,
          environment: cacheScope.environment,
        });
        return {
          success: true,
          exitCode: 0,
          logs: [],
          stepResults: [],
          compiledSql: engineResult.result.compiled_sql ?? undefined,
          raw: {
            success: true,
            commandResults: [],
            artifacts: {},
            projectChanged: false,
          },
        };
      }
      if (engineResult.kind === "show" && engineResult.result.ok) {
        logger.info("dbt engine show hit", {
          event: "dbt_engine_show",
          outcome: "hit",
          elapsedMs: engineResult.result.elapsed_ms,
          projectId: cacheScope.projectId,
          environment: cacheScope.environment,
        });
        return {
          success: true,
          exitCode: 0,
          logs: [],
          stepResults: [],
          preview: {
            columns: engineResult.result.columns,
            rows: engineResult.result.rows,
          },
          raw: {
            success: true,
            commandResults: [],
            artifacts: {},
            projectChanged: false,
          },
        };
      }
      logger.warn(
        `dbt engine ${parsed.subcommand} failed; falling back to subprocess`,
        {
          event:
            parsed.subcommand === "show"
              ? "dbt_engine_show"
              : "dbt_engine_compile",
          outcome: "fallback",
          reason: `${parsed.subcommand}_failed`,
          error: engineResult.result.error,
          projectId: cacheScope.projectId,
          environment: cacheScope.environment,
        },
      );
    } catch (error) {
      logger.warn("dbt engine unavailable; falling back to subprocess", {
        event:
          parsed.subcommand === "show"
            ? "dbt_engine_show"
            : "dbt_engine_compile",
        outcome: "fallback",
        reason: "unavailable",
        error: String(error),
        projectId: cacheScope.projectId,
        environment: cacheScope.environment,
      });
    }
  }

  // Interactive commands run in a warm dir (role=adhoc) kept separate from the
  // deploy executor's, so a long build never blocks a compile. The artifact
  // caches above seed a cold dir; thereafter the on-disk tree stays warm.
  const runOnce = (workingDir?: string) =>
    runDbt({
      files: snapshot.files,
      profile: snapshot.profile,
      commands: [parsed],
      dbtVersion: snapshot.project.dbtVersion,
      vars: snapshot.environment.vars,
      deferState: params.deferState,
      commandTimeoutMs: params.timeoutMs ?? 5 * 60 * 1000,
      seedPartialParse: caches.partialParse,
      seedPackagesArchive: caches.packages,
      skipDeps: caches.packagesFresh,
      packagesHash,
      workingDir,
      signal: params.signal,
    });

  let raw: Awaited<ReturnType<typeof runDbt>> | undefined;
  if (warmDirsEnabled()) {
    try {
      raw = await withProjectDir(adhocDirScope, dir => runOnce(dir));
      // Positive signal so warm-dir engagement is observable, not faith-based:
      // (hit count) vs the fallback warn below gives the warm-dir success rate.
      logger.info("dbt warm dir used", {
        event: "dbt_warm_dir",
        outcome: "hit",
        role: "adhoc",
        projectId: cacheScope.projectId,
        environment: cacheScope.environment,
      });
    } catch (error) {
      logger.warn("Warm dir run failed; falling back to throwaway dir", {
        event: "dbt_warm_dir",
        outcome: "fallback",
        role: "adhoc",
        error: String(error),
        projectId: cacheScope.projectId,
        environment: cacheScope.environment,
      });
    }
  }
  if (!raw) raw = await runOnce(undefined);

  // Only re-upload the parse cache when something actually changed (or the
  // store had no cache yet). A no-change run leaves the seeded cache current,
  // so skip the redundant upload — the msgpack's embedded timestamps would
  // otherwise make every run look "new".
  if (
    raw.artifacts.partialParse &&
    (raw.projectChanged || !caches.partialParse)
  ) {
    await saveParseCache(cacheScope, raw.artifacts.partialParse);
  }
  if (raw.artifacts.packagesArchive && packagesHash) {
    await savePackagesCache(
      cacheScope,
      raw.artifacts.packagesArchive,
      packagesHash,
    );
  }

  const commandResult = raw.commandResults[0];
  const logs = commandResult?.logLines ?? [];
  return {
    success: raw.success,
    exitCode: commandResult?.exitCode ?? 1,
    logs,
    stepResults: parseStepResults(commandResult?.runResults),
    compiledSql: findCompiledSql(raw, params.select),
    preview: parsed.subcommand === "show" ? parseShowPreview(logs) : undefined,
    raw,
  };
}

/** `--select` / `-s` value from a validated `show` command, if present. */
function extractShowSelect(parsed: ParsedDbtCommand): string | undefined {
  if (parsed.subcommand !== "show") return undefined;
  for (let i = 1; i < parsed.argv.length; i++) {
    const token = parsed.argv[i];
    if (token === "--select" || token === "-s") {
      return parsed.argv[i + 1];
    }
  }
  return undefined;
}

/** `--limit` value from a validated `show` command (default handled by caller). */
function extractShowLimit(parsed: ParsedDbtCommand): number | undefined {
  if (parsed.subcommand !== "show") return undefined;
  for (let i = 1; i < parsed.argv.length; i++) {
    if (parsed.argv[i] === "--limit") {
      const n = Number(parsed.argv[i + 1]);
      return Number.isFinite(n) && n > 0 ? Math.floor(n) : undefined;
    }
  }
  return undefined;
}

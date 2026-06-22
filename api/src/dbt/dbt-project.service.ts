/**
 * dbt project snapshot loading + ad-hoc execution helpers.
 *
 * Shared by the routes (compile / run-select endpoints), the Inngest
 * executor, and the agent's server-side verification tools so they all go
 * through identical validation: workspace scoping, environment resolution,
 * connection decryption, and command allowlisting.
 */

import { Types } from "mongoose";
import {
  DatabaseConnection,
  DbtFile,
  DbtProject,
  type IDatabaseConnection,
  type IDbtEnvironment,
  type IDbtProject,
} from "../database/workspace-schema";
import { renderDbtProfile, type RenderedProfile } from "./adapter-map";
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
} from "./dbt-engine.service";
import {
  computePackagesHash,
  loadDbtCaches,
  saveParseCache,
  savePackagesCache,
} from "./dbt-cache.service";
import { warmDirsEnabled, withProjectDir } from "./workspace-dir.service";
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

  const fileDocs = await DbtFile.find({
    projectId: project._id,
    is_deleted: { $ne: true },
  })
    .select("path content")
    .lean();

  const files = fileDocs.map(file => ({
    path: file.path,
    content: file.content ?? "",
  }));

  // Environment vars (environment.vars) are injected as `--vars` by runDbt for
  // every command, so callers just forward snapshot.environment.vars.

  return { project, environment, files, profile };
}

export interface AdhocDbtResult {
  success: boolean;
  exitCode: number;
  logs: DbtLogLine[];
  stepResults: ReturnType<typeof parseStepResults>;
  compiledSql?: string;
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
  });

  // Warm caches so parse/compile/show/build don't re-parse the whole project
  // (and skip `dbt deps` when packages are unchanged). Best-effort.
  const cacheScope = {
    workspaceId: params.workspaceId,
    projectId: params.projectId,
    environment: snapshot.environment.name,
  };
  const packagesHash = computePackagesHash(snapshot.files);
  const caches = await loadDbtCaches(cacheScope, packagesHash);

  // Resident-engine fast path: an offline `compile --select X` reuses an
  // in-memory manifest (no interpreter cold start, no full re-parse) — the
  // dbt Cloud "develop" feel. Held under the same adhoc warm-dir mutex so the
  // tree can't mutate while the engine reads it. Any failure (engine down,
  // package macros needing an install we don't have, introspective compile)
  // falls through to the subprocess path below, so correctness never depends
  // on the engine. Gated by DBT_ENGINE_ENABLED (default off).
  if (
    dbtEngineEnabled() &&
    warmDirsEnabled() &&
    parsed.subcommand === "compile" &&
    params.select &&
    // The engine path does not apply --vars; skip it when the environment sets
    // vars so var() resolves correctly via the subprocess path below.
    Object.keys(snapshot.environment.vars ?? {}).length === 0
  ) {
    const select = params.select;
    try {
      const engineResult = await withProjectDir(
        { ...cacheScope, role: "adhoc" },
        async dir => {
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
          const session = {
            key: `${params.workspaceId}:${params.projectId}:${snapshot.environment.name}`,
            projectDir: dir,
          };
          // Re-parse to pick up edits (cheap via partial parse), then reuse the
          // warm manifest to compile.
          await enginePrepare(ctx, session);
          return engineCompile(ctx, session, select);
        },
      );
      if (engineResult.ok) {
        // info (not debug) so the hit rate is visible in prod once the engine
        // flag is on — pairs with the fallback warns below for a hit/miss rate.
        logger.info("dbt engine compile hit", {
          event: "dbt_engine_compile",
          outcome: "hit",
          elapsedMs: engineResult.elapsed_ms,
          projectId: cacheScope.projectId,
          environment: cacheScope.environment,
        });
        return {
          success: true,
          exitCode: 0,
          logs: [],
          stepResults: [],
          compiledSql: engineResult.compiled_sql ?? undefined,
          raw: {
            success: true,
            commandResults: [],
            artifacts: {},
            projectChanged: false,
          },
        };
      }
      logger.warn("dbt engine compile failed; falling back to subprocess", {
        event: "dbt_engine_compile",
        outcome: "fallback",
        reason: "compile_failed",
        error: engineResult.error,
        projectId: cacheScope.projectId,
        environment: cacheScope.environment,
      });
    } catch (error) {
      logger.warn("dbt engine unavailable; falling back to subprocess", {
        event: "dbt_engine_compile",
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
      raw = await withProjectDir({ ...cacheScope, role: "adhoc" }, dir =>
        runOnce(dir),
      );
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
  return {
    success: raw.success,
    exitCode: commandResult?.exitCode ?? 1,
    logs: commandResult?.logLines ?? [],
    stepResults: parseStepResults(commandResult?.runResults),
    compiledSql: findCompiledSql(raw, params.select),
    raw,
  };
}

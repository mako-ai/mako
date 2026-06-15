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
  parseStepResults,
  runDbt,
  type DbtLogLine,
  type DbtRunResult,
} from "./runner.service";

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

  // Environment vars: merge into every command via a vars file would change
  // semantics; instead they're applied by callers via --vars when present.

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

  const raw = await runDbt({
    files: snapshot.files,
    profile: snapshot.profile,
    commands: [parsed],
    dbtVersion: snapshot.project.dbtVersion,
    deferState: params.deferState,
    commandTimeoutMs: params.timeoutMs ?? 5 * 60 * 1000,
    signal: params.signal,
  });

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

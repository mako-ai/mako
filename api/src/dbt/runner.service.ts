/**
 * dbt runner — materializes a project snapshot to a temp dir and executes
 * dbt commands as a subprocess with JSON log streaming.
 *
 * Security: credentials are passed only through the child-process env
 * (profiles.yml references {{ env_var(...) }}); file paths are validated
 * against traversal; commands are pre-validated by commands.ts.
 */

import { spawn } from "child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { dirname, join, normalize, sep } from "path";
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
 * Materialize project files + profiles.yml into a temp dir, run each
 * pre-validated command in order (stopping at the first failure), collect
 * target/ artifacts, and always clean up the temp dir.
 */
export async function runDbt(request: DbtRunRequest): Promise<DbtRunResult> {
  const projectDir = await mkdtemp(join(tmpdir(), "mako-dbt-"));
  const commandResults: DbtCommandResult[] = [];
  const artifacts: DbtRunResult["artifacts"] = {};

  try {
    for (const file of request.files) {
      const safePath = ensureSafeRelativePath(file.path);
      const absolute = join(projectDir, ...safePath.split("/"));
      await mkdir(dirname(absolute), { recursive: true });
      await writeFile(absolute, file.content, "utf8");
    }
    await writeFile(
      join(projectDir, "profiles.yml"),
      request.profile.profilesYml,
      "utf8",
    );

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

    const resolved = resolveDbtBin(
      request.profile.adapterPackage,
      request.dbtVersion,
    );

    const childEnv: Record<string, string> = {
      ...(process.env as Record<string, string>),
      ...request.profile.secretEnv,
      DBT_SEND_ANONYMOUS_USAGE_STATS: "false",
      HOME: projectDir,
    };

    // Install packages first when declared. The executor runs one runDbt per
    // command, each in its own temp dir, so deps must be (re)installed here
    // before any command that depends on package macros can compile.
    if (projectHasPackages(request.files)) {
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

      const args = [
        ...resolved.prefixArgs,
        ...command.argv,
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

    return { success, commandResults, artifacts };
  } finally {
    await rm(projectDir, { recursive: true, force: true }).catch(() => {});
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

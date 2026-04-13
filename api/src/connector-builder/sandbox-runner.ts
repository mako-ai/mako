import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { builtinModules } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import { Sandbox } from "e2b";
import {
  type ConnectorExecutionLog,
  type ConnectorOutput,
  connectorOutputSchema,
} from "./output-schema";
import { getPaginateHelperSource } from "./paginate-helper";

const execFileAsync = promisify(execFile);
const buildCache = new Map<string, ConnectorBuildResult>();

const DEFAULT_SANDBOX_TIMEOUT_MS = 5 * 60 * 1000;
const builtinModuleNames = new Set(
  builtinModules.flatMap(name =>
    name.startsWith("node:") ? [name, name.replace(/^node:/, "")] : [name],
  ),
);

export interface ConnectorExecutionInput {
  config?: Record<string, unknown>;
  secrets?: Record<string, unknown>;
  state?: Record<string, unknown>;
  trigger?: {
    type?: "manual" | "webhook" | "schedule";
    payload?: unknown;
  };
  metadata?: Record<string, unknown>;
}

export interface ConnectorBuildError {
  message: string;
  line?: number;
  column?: number;
  raw?: string;
  severity?: "error" | "warning";
}

export interface ConnectorBuildResult {
  js?: string;
  sourceMap?: string;
  buildHash: string;
  buildLog: string;
  errors: ConnectorBuildError[];
  resolvedDependencies: string[];
  runtime: "e2b" | "local-fallback";
  builtAt: string;
}

export interface ConnectorExecutionResult {
  output: ConnectorOutput | null;
  logs: ConnectorExecutionLog[];
  runtime: "e2b" | "local-fallback";
  durationMs: number;
  rawOutput: string;
  error?: string;
}

function sha256(input: string): string {
  return createHash("sha256").update(input).digest("hex");
}

function normalizePackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }

  return specifier.split("/")[0];
}

function extractDependencies(code: string): string[] {
  const dependencies = new Set<string>();
  const importRegex =
    /(?:import\s+(?:[\w*\s{},]*?\s+from\s+)?|import\s*\()\s*["']([^"']+)["']|require\(\s*["']([^"']+)["']\s*\)/g;

  for (const match of code.matchAll(importRegex)) {
    const specifier = (match[1] || match[2] || "").trim();
    if (!specifier || specifier.startsWith(".") || specifier.startsWith("/")) {
      continue;
    }

    const packageName = normalizePackageName(specifier);
    if (!packageName || builtinModuleNames.has(packageName)) {
      continue;
    }

    dependencies.add(packageName);
  }

  return Array.from(dependencies).sort();
}

function parseBuildErrors(stderr: string): ConnectorBuildError[] {
  return stderr
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map<ConnectorBuildError>(line => {
      const match = line.match(/index\.ts:(\d+):(\d+):\s*(?:error:)?\s*(.*)$/i);
      if (!match) {
        return {
          message: line,
          raw: line,
          severity: "error",
        };
      }

      return {
        message: match[3] || line,
        line: Number.parseInt(match[1], 10),
        column: Number.parseInt(match[2], 10),
        raw: line,
        severity: "error",
      };
    });
}

function extractCommandFailure(error: unknown): {
  stdout: string;
  stderr: string;
  message: string;
} {
  if (error instanceof Error) {
    const commandError = error as Error & {
      stdout?: string;
      stderr?: string;
      error?: string;
    };

    return {
      stdout: commandError.stdout || "",
      stderr: commandError.stderr || "",
      message: commandError.error || commandError.message,
    };
  }

  return {
    stdout: "",
    stderr: "",
    message: "Command execution failed",
  };
}

function buildPackageJson(dependencies: string[]): string {
  const dependencyEntries = Object.fromEntries(
    dependencies.map(name => [name, "latest"]),
  );

  return JSON.stringify(
    {
      name: "connector-builder-runner",
      private: true,
      type: "commonjs",
      dependencies: dependencyEntries,
      devDependencies: {
        esbuild: "latest",
      },
    },
    null,
    2,
  );
}

async function buildLocally(
  code: string,
  dependencies: string[],
  buildHash: string,
): Promise<ConnectorBuildResult> {
  const builtAt = new Date().toISOString();

  if (dependencies.length > 0) {
    return {
      buildHash,
      buildLog:
        "Local fallback build cannot resolve external dependencies. Configure E2B_API_KEY to build connectors with npm packages.",
      errors: [
        {
          message:
            "Local fallback build does not support external dependencies. Configure E2B_API_KEY to use sandboxed builds.",
          severity: "error",
        },
      ],
      resolvedDependencies: dependencies,
      runtime: "local-fallback",
      builtAt,
    };
  }

  try {
    const ts = await import("typescript");
    const transpiled = ts.transpileModule(code, {
      compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2022,
        sourceMap: true,
        inlineSources: true,
        esModuleInterop: true,
      },
      fileName: "index.ts",
      reportDiagnostics: true,
    });

    const errors =
      transpiled.diagnostics?.map<ConnectorBuildError>(diagnostic => {
        const location =
          diagnostic.file && typeof diagnostic.start === "number"
            ? diagnostic.file.getLineAndCharacterOfPosition(diagnostic.start)
            : null;

        return {
          message: ts.flattenDiagnosticMessageText(
            diagnostic.messageText,
            "\n",
          ),
          line: location ? location.line + 1 : undefined,
          column: location ? location.character + 1 : undefined,
          severity:
            diagnostic.category === ts.DiagnosticCategory.Warning
              ? "warning"
              : "error",
        };
      }) ?? [];

    return {
      js: transpiled.outputText,
      sourceMap: transpiled.sourceMapText,
      buildHash,
      buildLog:
        errors.length > 0
          ? errors.map(error => error.message).join("\n")
          : "Built with local TypeScript fallback",
      errors,
      resolvedDependencies: dependencies,
      runtime: "local-fallback",
      builtAt,
    };
  } catch (error) {
    return {
      buildHash,
      buildLog:
        error instanceof Error ? error.message : "Local fallback build failed",
      errors: [
        {
          message:
            error instanceof Error
              ? error.message
              : "Local fallback build failed",
          severity: "error",
        },
      ],
      resolvedDependencies: dependencies,
      runtime: "local-fallback",
      builtAt,
    };
  }
}

async function createSandbox(): Promise<Sandbox> {
  return Sandbox.create({
    timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
  });
}

async function runBundleInSandbox(
  bundle: string,
  input: ConnectorExecutionInput,
): Promise<ConnectorExecutionResult> {
  const sandbox = await createSandbox();
  const startedAt = Date.now();

  try {
    await sandbox.commands.run("mkdir -p /tmp/connector-builder");
    await sandbox.files.write([
      {
        path: "/tmp/connector-builder/bundle.js",
        data: bundle,
      },
      {
        path: "/tmp/connector-builder/input.json",
        data: JSON.stringify(input),
      },
      {
        path: "/tmp/connector-builder/runner.js",
        data: createRunnerSource(),
      },
    ]);

    const command = await sandbox.commands.run("node runner.js", {
      cwd: "/tmp/connector-builder",
      timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
    });

    const rawOutput = command.stdout.trim();
    const parsed = JSON.parse(rawOutput || "{}") as {
      result?: unknown;
      logs?: ConnectorExecutionLog[];
      error?: string;
    };
    const logs = Array.isArray(parsed.logs) ? parsed.logs : [];

    if (command.exitCode !== 0) {
      return {
        output: null,
        logs,
        runtime: "e2b",
        durationMs: Date.now() - startedAt,
        rawOutput,
        error:
          parsed.error ||
          command.stderr ||
          command.error ||
          "Sandbox execution failed",
      };
    }

    const output = connectorOutputSchema.parse(parsed.result ?? {});

    return {
      output: mergeLogsIntoOutput(output, logs),
      logs,
      runtime: "e2b",
      durationMs: Date.now() - startedAt,
      rawOutput,
    };
  } finally {
    await sandbox.kill().catch(() => undefined);
  }
}

async function runBundleLocally(
  bundle: string,
  input: ConnectorExecutionInput,
): Promise<ConnectorExecutionResult> {
  const startedAt = Date.now();
  const tempDirectory = await mkdtemp(
    path.join(tmpdir(), "mako-connector-builder-"),
  );

  try {
    await writeFile(path.join(tempDirectory, "bundle.js"), bundle, "utf8");
    await writeFile(
      path.join(tempDirectory, "input.json"),
      JSON.stringify(input),
      "utf8",
    );
    await writeFile(
      path.join(tempDirectory, "runner.js"),
      createRunnerSource(),
      "utf8",
    );

    let stdout = "";
    let stderr = "";
    try {
      const result = await execFileAsync("node", ["runner.js"], {
        cwd: tempDirectory,
        timeout: DEFAULT_SANDBOX_TIMEOUT_MS,
        maxBuffer: 10 * 1024 * 1024,
      });
      stdout = result.stdout;
      stderr = result.stderr;
    } catch (execError) {
      const failure = extractCommandFailure(execError);
      stdout = failure.stdout;
      stderr = failure.stderr;
    }

    const rawOutput = stdout.trim();
    const parsed = JSON.parse(rawOutput || "{}") as {
      result?: unknown;
      logs?: ConnectorExecutionLog[];
      error?: string;
    };
    const logs = Array.isArray(parsed.logs) ? parsed.logs : [];

    if (parsed.error || (!parsed.result && stderr.trim())) {
      return {
        output: null,
        logs,
        runtime: "local-fallback",
        durationMs: Date.now() - startedAt,
        rawOutput,
        error: parsed.error || stderr.trim() || "Local execution failed",
      };
    }

    const output = connectorOutputSchema.parse(parsed.result ?? {});

    return {
      output: mergeLogsIntoOutput(output, logs),
      logs,
      runtime: "local-fallback",
      durationMs: Date.now() - startedAt,
      rawOutput,
    };
  } finally {
    await rm(tempDirectory, { recursive: true, force: true }).catch(
      () => undefined,
    );
  }
}

function mergeLogsIntoOutput(
  output: ConnectorOutput,
  logs: ConnectorExecutionLog[],
): ConnectorOutput {
  const mergedLogs = [...(output.logs ?? []), ...logs];
  const rowCount = output.batches.reduce(
    (total, batch) => total + batch.rows.length,
    0,
  );

  return {
    ...output,
    logs: mergedLogs,
    metrics: {
      ...(output.metrics ?? {}),
      rowCount,
    },
  };
}

function createRunnerSource(): string {
  return `
const fs = require("node:fs");

${getPaginateHelperSource()}

function serializeLogValue(value) {
  if (value instanceof Error) {
    return {
      name: value.name,
      message: value.message,
      stack: value.stack,
    };
  }

  if (typeof value === "undefined") {
    return "undefined";
  }

  if (typeof value === "string") {
    return value;
  }

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
}

const logs = [];

const pushLog = (level, args) => {
  logs.push({
    level,
    message: args.map(serializeLogValue).join(" "),
    timestamp: new Date().toISOString(),
  });
};

console.log = (...args) => pushLog("info", args);
console.info = (...args) => pushLog("info", args);
console.warn = (...args) => pushLog("warn", args);
console.error = (...args) => pushLog("error", args);
console.debug = (...args) => pushLog("debug", args);

async function main() {
  const mod = require("./bundle.js");
  const pull =
    mod.pull ||
    mod.default?.pull ||
    mod.default;

  if (typeof pull !== "function") {
    throw new Error('Connector bundle must export a "pull" function');
  }

  const input = JSON.parse(fs.readFileSync("./input.json", "utf8"));

  const ctx = {
    fetch: globalThis.fetch.bind(globalThis),
    paginate,
    log: (...args) => pushLog("info", args),
  };

  const result = await pull({
    ...input,
    ctx,
  });

  process.stdout.write(JSON.stringify({ result, logs }));
}

main().catch(error => {
  const errorMessage = error instanceof Error ? error.stack || error.message : String(error);
  logs.push({
    level: "error",
    message: errorMessage,
    timestamp: new Date().toISOString(),
  });
  process.stdout.write(JSON.stringify({ result: null, logs, error: errorMessage }));
  process.exit(1);
});
`;
}

async function runBuildInSandbox(
  code: string,
  dependencies: string[],
  buildHash: string,
): Promise<ConnectorBuildResult> {
  const sandbox = await createSandbox();
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  try {
    await sandbox.commands.run("mkdir -p /tmp/connector-builder");
    await sandbox.files.write([
      {
        path: "/tmp/connector-builder/index.ts",
        data: code,
      },
      {
        path: "/tmp/connector-builder/package.json",
        data: buildPackageJson(dependencies),
      },
    ]);

    try {
      await sandbox.commands.run("npm install --yes --no-package-lock", {
        cwd: "/tmp/connector-builder",
        timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
        onStdout: data => {
          stdoutLines.push(data);
        },
        onStderr: data => {
          stderrLines.push(data);
        },
      });
    } catch (error) {
      const failure = extractCommandFailure(error);
      const buildLog = [
        ...stdoutLines,
        failure.stdout,
        ...stderrLines,
        failure.stderr,
      ]
        .filter(Boolean)
        .join("");
      return {
        buildHash,
        buildLog,
        errors: [
          {
            message: failure.message || "npm install failed inside sandbox",
            severity: "error",
          },
        ],
        resolvedDependencies: dependencies,
        runtime: "e2b",
        builtAt: new Date().toISOString(),
      };
    }

    try {
      await sandbox.commands.run(
        "npx esbuild index.ts --bundle --platform=node --format=cjs --target=node20 --sourcemap=external --outfile=bundle.js",
        {
          cwd: "/tmp/connector-builder",
          timeoutMs: DEFAULT_SANDBOX_TIMEOUT_MS,
          onStdout: data => {
            stdoutLines.push(data);
          },
          onStderr: data => {
            stderrLines.push(data);
          },
        },
      );
    } catch (error) {
      const failure = extractCommandFailure(error);
      const buildLog = [
        ...stdoutLines,
        failure.stdout,
        ...stderrLines,
        failure.stderr,
      ]
        .filter(Boolean)
        .join("");
      const errors = parseBuildErrors(buildLog);
      return {
        buildHash,
        buildLog,
        errors:
          errors.length > 0
            ? errors
            : [
                {
                  message: failure.message || "Build failed",
                  severity: "error",
                },
              ],
        resolvedDependencies: dependencies,
        runtime: "e2b",
        builtAt: new Date().toISOString(),
      };
    }

    const buildLog = [...stdoutLines, ...stderrLines].join("");
    const builtAt = new Date().toISOString();
    const [js, sourceMap] = await Promise.all([
      sandbox.files.read("/tmp/connector-builder/bundle.js"),
      sandbox.files.read("/tmp/connector-builder/bundle.js.map"),
    ]);

    return {
      js,
      sourceMap,
      buildHash,
      buildLog,
      errors: [],
      resolvedDependencies: dependencies,
      runtime: "e2b",
      builtAt,
    };
  } finally {
    await sandbox.kill().catch(() => undefined);
  }
}

export const sandboxRunner = {
  async build(code: string): Promise<ConnectorBuildResult> {
    const buildHash = sha256(code);
    const cached = buildCache.get(buildHash);
    if (cached) {
      return cached;
    }

    const dependencies = extractDependencies(code);
    const result = process.env.E2B_API_KEY
      ? await runBuildInSandbox(code, dependencies, buildHash)
      : await buildLocally(code, dependencies, buildHash);

    if (result.js && result.errors.length === 0) {
      buildCache.set(buildHash, result);
    }

    return result;
  },

  async execute(
    bundle: string,
    input: ConnectorExecutionInput,
  ): Promise<ConnectorExecutionResult> {
    return process.env.E2B_API_KEY
      ? runBundleInSandbox(bundle, input)
      : runBundleLocally(bundle, input);
  },
};

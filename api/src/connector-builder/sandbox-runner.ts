import { Sandbox } from "e2b";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { builtinModules } from "node:module";
import path from "node:path";
import { promisify } from "node:util";
import {
  ConnectorOutput,
  ConnectorInput,
  connectorOutputSchema,
} from "./output-schema";
import { getPaginateHelperCode } from "./paginate-helper";

const execFileAsync = promisify(execFile);

const SANDBOX_TIMEOUT_MS = 5 * 60 * 1000;
const buildCache = new Map<string, BuildResult>();

export type Runtime = "e2b" | "local-fallback";

const builtinModuleNames = new Set(
  builtinModules.flatMap(name =>
    name.startsWith("node:") ? [name, name.replace(/^node:/, "")] : [name],
  ),
);

export interface BuildError {
  message: string;
  line?: number;
  column?: number;
  severity: "error" | "warning";
  raw?: string;
}

export interface BuildResult {
  js: string;
  sourceMap: string;
  buildHash: string;
  buildLog: string;
  errors: BuildError[];
  resolvedDependencies: string[];
  runtime: Runtime;
}

export interface ExecuteResult {
  output: ConnectorOutput;
  logs: Array<{
    level: string;
    message: string;
    timestamp?: string;
  }>;
  runtime: Runtime;
  durationMs: number;
}

export function computeBuildHash(code: string): string {
  return createHash("sha256").update(code).digest("hex");
}

function normalizePackageName(specifier: string): string {
  if (specifier.startsWith("@")) {
    const parts = specifier.split("/");
    return parts.slice(0, 2).join("/");
  }
  return specifier.split("/")[0];
}

function extractDependencies(code: string): string[] {
  const deps = new Set<string>();
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
    deps.add(packageName);
  }

  return Array.from(deps).sort();
}

function parseBuildErrors(output: string): BuildError[] {
  return output
    .split("\n")
    .map(line => line.trim())
    .filter(Boolean)
    .map<BuildError>(line => {
      const m = line.match(
        /(?:connector|index)\.ts:(\d+):(\d+):\s*(?:(error|warning):)?\s*(.*)$/i,
      );
      if (!m) {
        return { message: line, severity: "error", raw: line };
      }
      return {
        message: m[4] || line,
        line: parseInt(m[1], 10),
        column: parseInt(m[2], 10),
        severity: (m[3]?.toLowerCase() as "error" | "warning") || "error",
        raw: line,
      };
    });
}

function buildPackageJson(dependencies: string[]): string {
  return JSON.stringify(
    {
      name: "connector-builder-runner",
      private: true,
      type: "commonjs",
      dependencies: Object.fromEntries(dependencies.map(d => [d, "latest"])),
      devDependencies: { esbuild: "latest" },
    },
    null,
    2,
  );
}

/**
 * Runner script injected into sandbox / local temp directory.
 * Intercepts console.* for structured log capture.
 */
function createRunnerSource(): string {
  return `
const fs = require("node:fs");

${getPaginateHelperCode()}

function serializeLogValue(value) {
  if (value instanceof Error) {
    return { name: value.name, message: value.message, stack: value.stack };
  }
  if (typeof value === "undefined") return "undefined";
  if (typeof value === "string") return value;
  try { return JSON.stringify(value); } catch { return String(value); }
}

async function main() {
  const mod = require("./bundle.js");
  const pull = mod.pull || mod.default?.pull || mod.default;
  if (typeof pull !== "function") {
    throw new Error('Connector bundle must export a "pull" function');
  }

  const logs = [];
  const input = JSON.parse(fs.readFileSync("./input.json", "utf8"));

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

  const ctx = {
    fetch: globalThis.fetch.bind(globalThis),
    paginate,
    log: (...args) => pushLog("info", args),
  };

  const result = await pull({ ...input, ctx });
  process.stdout.write(JSON.stringify({ result, logs }));
}

main().catch(error => {
  process.stderr.write(
    error instanceof Error ? error.stack || error.message : String(error),
  );
  process.exit(1);
});
`;
}

// ── E2B sandbox build ──

async function runBuildInSandbox(
  code: string,
  dependencies: string[],
  buildHash: string,
): Promise<BuildResult> {
  const sandbox = await Sandbox.create("base", {
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });
  const stdoutLines: string[] = [];
  const stderrLines: string[] = [];

  try {
    await sandbox.files.write("connector.ts", code);
    await sandbox.files.write("package.json", buildPackageJson(dependencies));

    const installResult = await sandbox.commands.run(
      "npm install --yes --no-package-lock 2>&1",
      { timeoutMs: SANDBOX_TIMEOUT_MS },
    );
    stdoutLines.push(installResult.stdout || "");
    stderrLines.push(installResult.stderr || "");

    if (installResult.exitCode !== 0) {
      const buildLog = [...stdoutLines, ...stderrLines].join("");
      return {
        js: "",
        sourceMap: "",
        buildHash,
        buildLog,
        errors: [
          { message: "npm install failed in sandbox", severity: "error" },
        ],
        resolvedDependencies: dependencies,
        runtime: "e2b",
      };
    }

    const esbuildCmd = [
      "npx esbuild connector.ts",
      "--bundle --platform=node --format=cjs --target=node20",
      "--sourcemap=external --outfile=bundle.js",
      "--external:node:*",
    ].join(" ");

    const buildResult = await sandbox.commands.run(esbuildCmd + " 2>&1", {
      timeoutMs: SANDBOX_TIMEOUT_MS,
    });
    stdoutLines.push(buildResult.stdout || "");
    stderrLines.push(buildResult.stderr || "");

    const buildLog = [...stdoutLines, ...stderrLines].join("");

    if (buildResult.exitCode !== 0) {
      const errors = parseBuildErrors(buildLog);
      return {
        js: "",
        sourceMap: "",
        buildHash,
        buildLog,
        errors:
          errors.length > 0
            ? errors
            : [{ message: "Build failed", severity: "error" }],
        resolvedDependencies: dependencies,
        runtime: "e2b",
      };
    }

    const js = await sandbox.files.read("bundle.js");
    let sourceMap = "";
    try {
      sourceMap = await sandbox.files.read("bundle.js.map");
    } catch {
      /* source map optional */
    }

    return {
      js,
      sourceMap,
      buildHash,
      buildLog,
      errors: [],
      resolvedDependencies: dependencies,
      runtime: "e2b",
    };
  } finally {
    await sandbox.kill().catch(() => undefined);
  }
}

// ── Local fallback build (no E2B key) ──

async function buildLocally(
  code: string,
  dependencies: string[],
  buildHash: string,
): Promise<BuildResult> {
  if (dependencies.length > 0) {
    return {
      js: "",
      sourceMap: "",
      buildHash,
      buildLog:
        "Local fallback build cannot resolve external dependencies. Set E2B_API_KEY for sandboxed builds with npm packages.",
      errors: [
        {
          message:
            "Local fallback does not support external dependencies. Set E2B_API_KEY to use sandboxed builds.",
          severity: "error",
        },
      ],
      resolvedDependencies: dependencies,
      runtime: "local-fallback",
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
      reportDiagnostics: true,
    });

    const errors: BuildError[] = [];
    if (transpiled.diagnostics && transpiled.diagnostics.length > 0) {
      for (const diag of transpiled.diagnostics) {
        const msg = ts.flattenDiagnosticMessageText(diag.messageText, "\n");
        let line: number | undefined;
        let column: number | undefined;
        if (diag.file && diag.start !== undefined) {
          const pos = diag.file.getLineAndCharacterOfPosition(diag.start);
          line = pos.line + 1;
          column = pos.character + 1;
        }
        errors.push({ message: msg, line, column, severity: "error" });
      }
    }

    return {
      js: transpiled.outputText,
      sourceMap: transpiled.sourceMapText || "",
      buildHash,
      buildLog: "Built locally via TypeScript compiler (no E2B sandbox)",
      errors,
      resolvedDependencies: [],
      runtime: "local-fallback",
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      js: "",
      sourceMap: "",
      buildHash,
      buildLog: `Local build failed: ${message}`,
      errors: [{ message, severity: "error" }],
      resolvedDependencies: [],
      runtime: "local-fallback",
    };
  }
}

// ── E2B sandbox execution ──

async function runBundleInSandbox(
  bundle: string,
  input: ConnectorInput,
): Promise<ExecuteResult> {
  const startedAt = Date.now();
  const sandbox = await Sandbox.create("base", {
    timeoutMs: SANDBOX_TIMEOUT_MS,
  });

  try {
    await sandbox.files.write("bundle.js", bundle);
    await sandbox.files.write("input.json", JSON.stringify(input));
    await sandbox.files.write("runner.js", createRunnerSource());

    const execResult = await sandbox.commands.run("node runner.js", {
      timeoutMs: SANDBOX_TIMEOUT_MS,
    });

    return parseRunnerOutput(
      execResult.stdout || "",
      execResult.stderr || "",
      execResult.exitCode || 0,
      "e2b",
      Date.now() - startedAt,
    );
  } finally {
    await sandbox.kill().catch(() => undefined);
  }
}

// ── Local fallback execution ──

async function runBundleLocally(
  bundle: string,
  input: ConnectorInput,
): Promise<ExecuteResult> {
  const startedAt = Date.now();
  const tempDir = await mkdtemp(path.join(tmpdir(), "mako-connector-builder-"));

  try {
    await writeFile(path.join(tempDir, "bundle.js"), bundle, "utf8");
    await writeFile(
      path.join(tempDir, "input.json"),
      JSON.stringify(input),
      "utf8",
    );
    await writeFile(
      path.join(tempDir, "runner.js"),
      createRunnerSource(),
      "utf8",
    );

    const { stdout, stderr } = await execFileAsync("node", ["runner.js"], {
      cwd: tempDir,
      timeout: SANDBOX_TIMEOUT_MS,
      maxBuffer: 10 * 1024 * 1024,
    });

    return parseRunnerOutput(
      stdout || "",
      stderr || "",
      0,
      "local-fallback",
      Date.now() - startedAt,
    );
  } catch (err: unknown) {
    const durationMs = Date.now() - startedAt;
    const stderr =
      err instanceof Error
        ? (err as Error & { stderr?: string }).stderr || err.message
        : String(err);
    return parseRunnerOutput("", stderr, 1, "local-fallback", durationMs);
  } finally {
    await rm(tempDir, { recursive: true, force: true }).catch(() => undefined);
  }
}

// ── Shared output parsing ──

function parseRunnerOutput(
  stdout: string,
  stderr: string,
  exitCode: number,
  runtime: Runtime,
  durationMs: number,
): ExecuteResult {
  const rawOutput = stdout.trim();

  if (exitCode !== 0 || (!rawOutput && stderr.trim())) {
    return {
      output: {
        batches: [],
        state: {},
        hasMore: false,
        logs: [
          {
            level: "error",
            message: stderr.trim() || `Process exited with code ${exitCode}`,
            timestamp: new Date().toISOString(),
          },
        ],
      },
      logs: [],
      runtime,
      durationMs,
    };
  }

  try {
    const parsed = JSON.parse(rawOutput || "{}") as {
      result?: unknown;
      logs?: Array<{ level: string; message: string; timestamp?: string }>;
    };

    const output = connectorOutputSchema.parse(parsed.result ?? {});
    const logs = Array.isArray(parsed.logs) ? parsed.logs : [];

    const mergedLogs = [...(output.logs ?? []), ...logs];

    return {
      output: { ...output, logs: mergedLogs },
      logs,
      runtime,
      durationMs,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      output: {
        batches: [],
        state: {},
        hasMore: false,
        logs: [
          {
            level: "error",
            message: `Failed to parse connector output: ${message}`,
            timestamp: new Date().toISOString(),
          },
        ],
      },
      logs: [],
      runtime,
      durationMs,
    };
  }
}

// ── Public API (object style for clarity) ──

export const sandboxRunner = {
  /**
   * Build connector code. Uses E2B if E2B_API_KEY is set, otherwise falls
   * back to local TypeScript compilation (zero-dependency connectors only).
   * Results are cached in-memory by content hash.
   */
  async build(code: string): Promise<BuildResult> {
    const buildHash = computeBuildHash(code);
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

  /**
   * Execute a built bundle with the given input context.
   * Uses E2B if E2B_API_KEY is set, otherwise runs locally via child_process.
   */
  async execute(bundle: string, input: ConnectorInput): Promise<ExecuteResult> {
    return process.env.E2B_API_KEY
      ? runBundleInSandbox(bundle, input)
      : runBundleLocally(bundle, input);
  },
};

// Legacy named exports for backward compatibility with routes
export const buildConnector = sandboxRunner.build;
export const executeConnector = sandboxRunner.execute;

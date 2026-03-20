import { Sandbox } from "e2b";
import * as crypto from "crypto";
import { loggers } from "../logging";
import {
  ConnectorOutput,
  ConnectorInput,
  validateConnectorOutput,
} from "./output-schema";
import { getPaginateHelperCode } from "./paginate-helper";

const logger = loggers.connector("sandbox-runner");

const SANDBOX_TIMEOUT_MS = 60_000;
const BUILD_TIMEOUT_MS = 120_000;

export interface BuildResult {
  js: string;
  sourceMap: string;
  buildHash: string;
  buildLog: string;
  errors: Array<{
    line?: number;
    column?: number;
    message: string;
    severity: "error" | "warning";
  }>;
  resolvedDependencies: Record<string, string>;
}

export interface ExecuteResult {
  output: ConnectorOutput;
  logs: string;
  durationMs: number;
}

/**
 * Compute SHA-256 hash of source code for cache invalidation.
 */
export function computeBuildHash(code: string): string {
  return crypto.createHash("sha256").update(code).digest("hex");
}

/**
 * Parse import/require statements from TypeScript/JavaScript source to extract npm package names.
 */
function extractDependencies(code: string): string[] {
  const deps = new Set<string>();

  const importRegex =
    /(?:import\s+.*?\s+from\s+['"]([^'"./][^'"]*?)['"]|require\s*\(\s*['"]([^'"./][^'"]*?)['"]\s*\))/g;
  let match: RegExpExecArray | null;
  while ((match = importRegex.exec(code)) !== null) {
    const pkg = match[1] || match[2];
    if (pkg) {
      // Extract the package name (handle scoped packages like @scope/name)
      const parts = pkg.split("/");
      const name =
        parts[0].startsWith("@") && parts.length > 1
          ? `${parts[0]}/${parts[1]}`
          : parts[0];
      deps.add(name);
    }
  }

  return Array.from(deps);
}

/**
 * Build user connector code in an E2B sandbox.
 *
 * - Parses imports to discover dependencies
 * - Generates package.json
 * - Runs npm install && esbuild to produce a CommonJS bundle
 */
export async function buildConnector(code: string): Promise<BuildResult> {
  const buildHash = computeBuildHash(code);
  const dependencies = extractDependencies(code);

  const packageJson: Record<string, unknown> = {
    name: "user-connector",
    version: "1.0.0",
    private: true,
    dependencies: Object.fromEntries(dependencies.map(d => [d, "latest"])),
    devDependencies: {
      esbuild: "^0.20.0",
      typescript: "^5.4.0",
    },
  };

  const tsconfig = {
    compilerOptions: {
      target: "ES2022",
      module: "commonjs",
      moduleResolution: "node",
      esModuleInterop: true,
      strict: false,
      skipLibCheck: true,
      outDir: "./dist",
    },
  };

  let sandbox: Sandbox | null = null;
  const errors: BuildResult["errors"] = [];
  let buildLog = "";

  try {
    sandbox = await Sandbox.create("base", {
      timeoutMs: BUILD_TIMEOUT_MS,
    });

    await sandbox.files.write("connector.ts", code);
    await sandbox.files.write(
      "package.json",
      JSON.stringify(packageJson, null, 2),
    );
    await sandbox.files.write(
      "tsconfig.json",
      JSON.stringify(tsconfig, null, 2),
    );

    const installResult = await sandbox.commands.run(
      "npm install --no-audit --no-fund 2>&1",
      { timeoutMs: 60_000 },
    );
    buildLog += installResult.stdout + "\n" + installResult.stderr + "\n";

    if (installResult.exitCode !== 0) {
      errors.push({
        message: `npm install failed: ${installResult.stderr || installResult.stdout}`,
        severity: "error",
      });
      return {
        js: "",
        sourceMap: "",
        buildHash,
        buildLog,
        errors,
        resolvedDependencies: {},
      };
    }

    const esbuildCmd = [
      "npx esbuild connector.ts",
      "--bundle",
      "--platform=node",
      "--target=node20",
      "--format=cjs",
      "--outfile=bundle.js",
      "--sourcemap=external",
      "--external:node:*",
      "2>&1",
    ].join(" ");

    const buildResult = await sandbox.commands.run(esbuildCmd, {
      timeoutMs: 30_000,
    });
    buildLog += buildResult.stdout + "\n" + buildResult.stderr + "\n";

    if (buildResult.exitCode !== 0) {
      const errorOutput = buildResult.stderr || buildResult.stdout || "";
      const lineMatch = errorOutput.match(
        /connector\.ts:(\d+):(\d+):\s*(error|warning):\s*(.*)/g,
      );
      if (lineMatch) {
        for (const line of lineMatch) {
          const m = line.match(
            /connector\.ts:(\d+):(\d+):\s*(error|warning):\s*(.*)/,
          );
          if (m) {
            errors.push({
              line: parseInt(m[1], 10),
              column: parseInt(m[2], 10),
              message: m[4],
              severity: m[3] as "error" | "warning",
            });
          }
        }
      } else {
        errors.push({
          message: `Build failed: ${errorOutput}`,
          severity: "error",
        });
      }

      return {
        js: "",
        sourceMap: "",
        buildHash,
        buildLog,
        errors,
        resolvedDependencies: {},
      };
    }

    const js = await sandbox.files.read("bundle.js");
    let sourceMap = "";
    try {
      sourceMap = await sandbox.files.read("bundle.js.map");
    } catch {
      // Source map may not be generated in all cases
    }

    // Read resolved dependency versions
    let resolvedDependencies: Record<string, string> = {};
    try {
      const lockContent = await sandbox.files.read("package.json");
      const pkgData = JSON.parse(lockContent);
      resolvedDependencies =
        (pkgData.dependencies as Record<string, string>) || {};
    } catch {
      // Non-critical
    }

    // Check for warnings in build output
    const warnRegex = /connector\.ts:(\d+):(\d+):\s*warning:\s*(.*)/g;
    let warnMatch: RegExpExecArray | null;
    while (
      (warnMatch = warnRegex.exec(buildResult.stdout + buildResult.stderr)) !==
      null
    ) {
      errors.push({
        line: parseInt(warnMatch[1], 10),
        column: parseInt(warnMatch[2], 10),
        message: warnMatch[3],
        severity: "warning",
      });
    }

    return {
      js,
      sourceMap,
      buildHash,
      buildLog,
      errors,
      resolvedDependencies,
    };
  } catch (err: unknown) {
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Sandbox build failed", { error: err });
    errors.push({ message: `Sandbox error: ${message}`, severity: "error" });
    return {
      js: "",
      sourceMap: "",
      buildHash,
      buildLog,
      errors,
      resolvedDependencies: {},
    };
  } finally {
    if (sandbox) {
      try {
        await sandbox.kill();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

/**
 * Execute a built connector bundle in an E2B sandbox.
 *
 * Writes the bundle and a runner wrapper to the sandbox,
 * executes it, and parses + validates the JSON output.
 */
export async function executeConnector(
  bundleJs: string,
  input: ConnectorInput,
): Promise<ExecuteResult> {
  let sandbox: Sandbox | null = null;
  const startTime = Date.now();

  try {
    sandbox = await Sandbox.create("base", {
      timeoutMs: SANDBOX_TIMEOUT_MS,
    });

    await sandbox.files.write("bundle.js", bundleJs);

    const paginateCode = getPaginateHelperCode();

    const runnerCode = `
const mod = require("./bundle.js");
const input = JSON.parse(process.env.CONNECTOR_INPUT || "{}");

${paginateCode}

const ctx = {
  config: input.config || {},
  secrets: input.secrets || {},
  state: input.state || {},
  trigger: input.trigger || { type: "manual" },
  paginate: paginate,
  log: function(level, message, data) {
    const entry = { level: level, message: message, timestamp: new Date().toISOString(), data: data };
    process.stderr.write("__LOG__" + JSON.stringify(entry) + "\\n");
  },
};

// Convenience logging methods
ctx.log.info = function(msg, data) { ctx.log("info", msg, data); };
ctx.log.warn = function(msg, data) { ctx.log("warn", msg, data); };
ctx.log.error = function(msg, data) { ctx.log("error", msg, data); };
ctx.log.debug = function(msg, data) { ctx.log("debug", msg, data); };

(async () => {
  try {
    const pullFn = mod.pull || mod.default?.pull || mod.default;
    if (typeof pullFn !== "function") {
      throw new Error("Connector must export a 'pull' function");
    }
    const result = await pullFn(ctx);
    process.stdout.write(JSON.stringify(result));
  } catch (err) {
    process.stderr.write("__ERROR__" + JSON.stringify({ message: err.message, stack: err.stack }) + "\\n");
    process.exit(1);
  }
})();
`;

    await sandbox.files.write("runner.js", runnerCode);

    const execResult = await sandbox.commands.run("node runner.js", {
      timeoutMs: SANDBOX_TIMEOUT_MS,
      envs: {
        CONNECTOR_INPUT: JSON.stringify(input),
      },
    });

    const durationMs = Date.now() - startTime;
    const stderr = execResult.stderr || "";
    const stdout = execResult.stdout || "";

    // Extract log entries from stderr
    const logEntries: Array<{
      level: "debug" | "info" | "warn" | "error";
      message: string;
      timestamp?: string;
      data?: unknown;
    }> = [];
    const logLines = stderr.split("\n");
    const stderrNonLog: string[] = [];
    for (const line of logLines) {
      if (line.startsWith("__LOG__")) {
        try {
          const entry = JSON.parse(line.slice(7));
          logEntries.push(entry);
        } catch {
          stderrNonLog.push(line);
        }
      } else if (line.startsWith("__ERROR__")) {
        try {
          const errorData = JSON.parse(line.slice(9));
          logEntries.push({
            level: "error",
            message: errorData.message || "Unknown error",
            timestamp: new Date().toISOString(),
            data: { stack: errorData.stack },
          });
        } catch {
          stderrNonLog.push(line);
        }
      } else if (line.trim()) {
        stderrNonLog.push(line);
      }
    }

    if (execResult.exitCode !== 0) {
      const errorMsg =
        stderrNonLog.join("\n") ||
        `Process exited with code ${execResult.exitCode}`;
      return {
        output: {
          batches: [],
          state: {},
          hasMore: false,
          logs: logEntries,
        },
        logs: errorMsg,
        durationMs,
      };
    }

    // Parse stdout as JSON
    let rawOutput: unknown;
    try {
      rawOutput = JSON.parse(stdout);
    } catch {
      return {
        output: {
          batches: [],
          state: {},
          hasMore: false,
          logs: [
            ...logEntries,
            {
              level: "error" as const,
              message: `Failed to parse connector output as JSON: ${stdout.slice(0, 500)}`,
              timestamp: new Date().toISOString(),
            },
          ],
        },
        logs: stderrNonLog.join("\n"),
        durationMs,
      };
    }

    // Validate against schema
    const validation = validateConnectorOutput(rawOutput);
    if (!validation.success) {
      return {
        output: {
          batches: [],
          state: {},
          hasMore: false,
          logs: [
            ...logEntries,
            {
              level: "error" as const,
              message: validation.error,
              timestamp: new Date().toISOString(),
            },
          ],
        },
        logs: stderrNonLog.join("\n"),
        durationMs,
      };
    }

    // Merge log entries from stderr with those from the output itself
    const outputData = validation.data;
    outputData.logs = [...logEntries, ...(outputData.logs || [])];

    return {
      output: outputData,
      logs: stderrNonLog.join("\n"),
      durationMs,
    };
  } catch (err: unknown) {
    const durationMs = Date.now() - startTime;
    const message = err instanceof Error ? err.message : String(err);
    logger.error("Sandbox execution failed", { error: err });
    return {
      output: {
        batches: [],
        state: {},
        hasMore: false,
        logs: [
          {
            level: "error",
            message: `Sandbox error: ${message}`,
            timestamp: new Date().toISOString(),
          },
        ],
      },
      logs: message,
      durationMs,
    };
  } finally {
    if (sandbox) {
      try {
        await sandbox.kill();
      } catch {
        // Ignore cleanup errors
      }
    }
  }
}

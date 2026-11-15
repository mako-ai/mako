/**
 * Runs the MetricFlow engine (engine/metricflow_engine.py) against a stored
 * semantic manifest: what a set of metrics can be grouped by, and the SQL
 * for a metric query in a warehouse's dialect.
 *
 * Nothing here reaches a warehouse. The engine reads one JSON file and
 * renders SQL; Mako runs that SQL through its own drivers, under the same
 * access checks as any other query (agent-lib/tools/dbt-metric-tools.ts).
 *
 * One short-lived process per call: importing MetricFlow and compiling a
 * query takes well under a second, so there is no resident process to
 * supervise. Group-by listings are cached per manifest version.
 */
import { spawn } from "child_process";
import { createHash } from "crypto";
import { mkdir, rename, stat, unlink, writeFile } from "fs/promises";
import { tmpdir } from "os";
import { join } from "path";
import { loggers } from "../../logging";
import { buildDbtBaseEnv, resolveMetricflowPython } from "../dbt-bin";
import { readArtifactBuffer } from "./semantic-manifest.service";

const logger = loggers.api("dbt-metricflow");

const ENGINE_SCRIPT = join(__dirname, "..", "engine", "metricflow_engine.py");

/** A cold `uv` resolve in local dev is the slow case; prod answers in ~1s. */
const ENGINE_TIMEOUT_MS = 60_000;
const MAX_ENGINE_OUTPUT_BYTES = 8 * 1024 * 1024;
/** Manifest files kept on local disk, oldest dropped first. */
const MAX_MATERIALIZED_MANIFESTS = 40;
const MAX_DESCRIBE_CACHE = 200;

// ---------------------------------------------------------------------------
// Dialects
// ---------------------------------------------------------------------------

export type MetricflowDialect = "postgres" | "redshift" | "bigquery" | "duckdb";

/** Mako connection type → the MetricFlow SQL engine that renders for it. */
const DIALECT_BY_CONNECTION_TYPE: Readonly<Record<string, MetricflowDialect>> =
  {
    postgresql: "postgres",
    "cloudsql-postgres": "postgres",
    redshift: "redshift",
    bigquery: "bigquery",
  };

export const METRICFLOW_CONNECTION_TYPES = Object.keys(
  DIALECT_BY_CONNECTION_TYPE,
);

/** Undefined when MetricFlow cannot render SQL for that connection type. */
export function metricflowDialectFor(
  connectionType: string,
): MetricflowDialect | undefined {
  return DIALECT_BY_CONNECTION_TYPE[connectionType];
}

// ---------------------------------------------------------------------------
// The manifest on local disk
// ---------------------------------------------------------------------------

const manifestRoot = () =>
  process.env.MF_MANIFEST_DIR ?? join(tmpdir(), "mako-semantic-manifests");

/** Artifact key → local path, in order of first use. */
const materialized = new Map<string, Promise<string>>();

async function writeManifest(key: string): Promise<string> {
  const buffer = await readArtifactBuffer(key);
  if (!buffer) {
    throw new Error("The semantic manifest is no longer in the artifact store");
  }
  const root = manifestRoot();
  await mkdir(root, { recursive: true });
  const path = join(
    root,
    `${createHash("sha256").update(key).digest("hex").slice(0, 32)}.json`,
  );
  // Write-then-rename: a concurrent engine never reads a half-written file.
  const partial = `${path}.${process.pid}.${Date.now()}.tmp`;
  await writeFile(partial, buffer, { mode: 0o600 });
  await rename(partial, path);
  return path;
}

/** The local file holding the manifest stored under `key`. */
async function materializeManifest(key: string): Promise<string> {
  let pending = materialized.get(key);
  if (pending) {
    try {
      const path = await pending;
      await stat(path);
      return path;
    } catch {
      // Removed from disk (tmp cleanup) or a failed download: fetch again.
      materialized.delete(key);
    }
  }
  pending = writeManifest(key);
  materialized.set(key, pending);
  pending.catch(() => {
    if (materialized.get(key) === pending) materialized.delete(key);
  });
  const path = await pending;
  while (materialized.size > MAX_MATERIALIZED_MANIFESTS) {
    const [oldestKey, oldest] = materialized.entries().next().value as [
      string,
      Promise<string>,
    ];
    materialized.delete(oldestKey);
    void oldest.then(old => unlink(old)).catch(() => undefined);
  }
  return path;
}

// ---------------------------------------------------------------------------
// The engine process
// ---------------------------------------------------------------------------

/** A refusal from MetricFlow itself (unknown metric, no join path, …). */
export class MetricflowQueryError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MetricflowQueryError";
  }
}

type EngineResponse =
  | { ok: true; [key: string]: unknown }
  | {
      ok: false;
      error?: string;
    };

function runEngine(
  request: Record<string, unknown>,
  signal?: AbortSignal,
  maxWaitMs?: number,
): Promise<{ ok: true; [key: string]: unknown }> {
  const timeoutMs = Math.max(
    1000,
    Math.min(maxWaitMs ?? ENGINE_TIMEOUT_MS, ENGINE_TIMEOUT_MS),
  );
  return new Promise((resolve, reject) => {
    const { bin, prefixArgs } = resolveMetricflowPython(ENGINE_SCRIPT);
    // SECURITY: allowlisted base env only, as for every dbt child. A where
    // filter is a Jinja template; MetricFlow sandboxes it, and the server's
    // secrets are not in this environment to begin with.
    const child = spawn(bin, prefixArgs, {
      stdio: ["pipe", "pipe", "pipe"],
      env: buildDbtBaseEnv(),
      signal,
    });

    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish(() =>
        reject(
          new Error(
            `MetricFlow did not answer within ${Math.round(timeoutMs / 1000)}s`,
          ),
        ),
      );
    }, timeoutMs);

    child.stdout?.setEncoding("utf8");
    child.stdout?.on("data", (chunk: string) => {
      stdout += chunk;
      if (stdout.length > MAX_ENGINE_OUTPUT_BYTES) {
        child.kill("SIGKILL");
        finish(() => reject(new Error("MetricFlow produced too much output")));
      }
    });
    child.stderr?.setEncoding("utf8");
    child.stderr?.on("data", (chunk: string) => {
      // Keep the tail: a Python traceback ends with the reason.
      stderr = (stderr + chunk).slice(-4000);
    });
    child.on("error", error => finish(() => reject(error)));
    child.on("close", code => {
      finish(() => {
        const line = stdout.trim().split("\n").pop() ?? "";
        let response: EngineResponse | undefined;
        try {
          response = line ? (JSON.parse(line) as EngineResponse) : undefined;
        } catch {
          response = undefined;
        }
        if (!response) {
          logger.warn("MetricFlow engine gave no response", {
            code,
            stderr: stderr.slice(-1000),
          });
          reject(
            new Error(
              `MetricFlow engine failed (exit ${code}): ${
                stderr.trim().split("\n").pop() ?? "no output"
              }`,
            ),
          );
          return;
        }
        if (!response.ok) {
          reject(
            new MetricflowQueryError(
              response.error ?? "MetricFlow refused the query",
            ),
          );
          return;
        }
        resolve(response);
      });
    });

    child.stdin?.on("error", () => undefined);
    child.stdin?.end(JSON.stringify(request));
  });
}

// ---------------------------------------------------------------------------
// describe: what metrics can be grouped by
// ---------------------------------------------------------------------------

export interface MetricGroupByDimension {
  /** As a query names it: `metric_time__day`, `customer__region`. */
  name: string;
  /** `time` or `categorical`. */
  type: string;
  /** Time dimensions: the name without its grain (`metric_time`). */
  base?: string;
  /** Time dimensions: the finest grain; coarser ones replace the suffix. */
  grain?: string;
  label?: string;
  description?: string;
}

export interface MetricGroupByEntity {
  name: string;
  type: string;
  description?: string;
}

export interface MetricGroupBys {
  dimensions: MetricGroupByDimension[];
  entities: MetricGroupByEntity[];
}

const describeCache = new Map<string, Promise<MetricGroupBys>>();

/** Forget cached group-by listings and materialized manifests (tests). */
export function clearMetricflowCaches(): void {
  describeCache.clear();
  materialized.clear();
}

/**
 * The dimensions and entities ALL the given metrics can be grouped by
 * together. Throws MetricflowQueryError when a metric does not exist.
 */
export async function describeMetricGroupBys(
  semanticManifestKey: string,
  metrics: readonly string[],
): Promise<MetricGroupBys> {
  const cacheKey = `${semanticManifestKey}\n${[...metrics].sort().join("\n")}`;
  let pending = describeCache.get(cacheKey);
  if (!pending) {
    pending = (async () => {
      const manifestPath = await materializeManifest(semanticManifestKey);
      const response = await runEngine({
        op: "describe",
        manifest_path: manifestPath,
        metrics,
      });
      return {
        dimensions: (response.dimensions ?? []) as MetricGroupByDimension[],
        entities: (response.entities ?? []) as MetricGroupByEntity[],
      };
    })();
    describeCache.set(cacheKey, pending);
    const built = pending;
    built.catch(() => {
      if (describeCache.get(cacheKey) === built) describeCache.delete(cacheKey);
    });
    while (describeCache.size > MAX_DESCRIBE_CACHE) {
      describeCache.delete(describeCache.keys().next().value as string);
    }
  }
  return pending;
}

// ---------------------------------------------------------------------------
// compile: a metric query → SQL
// ---------------------------------------------------------------------------

export interface MetricQuery {
  metrics: readonly string[];
  groupBy?: readonly string[];
  where?: readonly string[];
  orderBy?: readonly string[];
  limit?: number;
  /** ISO 8601, inclusive bounds on metric_time. */
  startTime?: string;
  endTime?: string;
}

/**
 * The SQL MetricFlow writes for a metric query, in `dialect`. Throws
 * MetricflowQueryError with MetricFlow's own message (it lists the closest
 * metric and group-by names) when the query does not resolve.
 */
export async function compileMetricQuery(
  semanticManifestKey: string,
  dialect: MetricflowDialect,
  query: MetricQuery,
  signal?: AbortSignal,
  /** Give up sooner than the engine's own timeout (a caller's budget). */
  maxWaitMs?: number,
): Promise<string> {
  const manifestPath = await materializeManifest(semanticManifestKey);
  const response = await runEngine(
    {
      op: "compile",
      manifest_path: manifestPath,
      dialect,
      metrics: query.metrics,
      group_by: query.groupBy ?? [],
      where: query.where ?? [],
      order_by: query.orderBy ?? [],
      limit: query.limit ?? null,
      start_time: query.startTime ?? null,
      end_time: query.endTime ?? null,
    },
    signal,
    maxWaitMs,
  );
  if (typeof response.sql !== "string" || !response.sql.trim()) {
    throw new Error("MetricFlow returned no SQL");
  }
  return response.sql;
}

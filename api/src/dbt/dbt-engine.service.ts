/**
 * Resident dbt engine supervisor.
 *
 * Manages long-lived `dbt_engine.py` child processes that hold parsed dbt
 * manifests in memory, so interactive `compile`/`show` reuse the manifest and
 * skip re-parse (the dbt Cloud "develop" model). One process per
 * `(adapterPackage, dbtCoreVersion)` — each holds manifests for many
 * `(project, environment)` sessions using that adapter.
 *
 * Communication is newline-delimited JSON over a dedicated pipe (fd 3), so
 * dbt's own stdout/stderr logging never corrupts the protocol. Every request
 * is bounded by a timeout; a crashed process is reaped and respawned lazily,
 * and all callers fall back to the subprocess path when the engine is
 * unavailable — so this is strictly an optimization, never a dependency.
 *
 * Gated by DBT_ENGINE_ENABLED (default off) until validated against a real
 * warehouse in staging.
 */

import { spawn, type ChildProcess } from "child_process";
import { createHash } from "crypto";
import { join } from "path";
import { resolveDbtEnginePython } from "./dbt-bin";
import { loggers } from "../logging";

const logger = loggers.app();

const ENGINE_SCRIPT = join(__dirname, "engine", "dbt_engine.py");
const DEFAULT_REQUEST_TIMEOUT_MS = 60_000;
/** Max resident engine processes per API instance (LRU-evicted). */
const MAX_ENGINES = Number(process.env.DBT_ENGINE_MAX_PROCESSES ?? "4");

export function dbtEngineEnabled(): boolean {
  return process.env.DBT_ENGINE_ENABLED === "true";
}

export interface EngineSession {
  /** Stable key, e.g. `${workspaceId}:${projectId}:${environment}`. */
  key: string;
  /** Warm working directory the supervisor keeps in sync on disk. */
  projectDir: string;
}

interface PreparePayload {
  parse_ms: number;
  nodes: number;
}
interface CompilePayload {
  ok: boolean;
  compiled_sql: string | null;
  elapsed_ms: number;
  error: string | null;
}
interface ShowPayload {
  ok: boolean;
  columns: string[];
  rows: unknown[][];
  elapsed_ms: number;
  error: string | null;
}

interface PendingRequest {
  resolve: (value: Record<string, unknown>) => void;
  reject: (error: Error) => void;
  timer: NodeJS.Timeout;
}

/** One supervised Python engine process for a single adapter+version+connection. */
class EngineProcess {
  private child: ChildProcess | null = null;
  private buffer = "";
  private nextId = 1;
  private readonly pending = new Map<number, PendingRequest>();
  /** For LRU eviction. */
  lastUsed = Date.now();

  constructor(
    private readonly adapterPackage: string,
    private readonly dbtVersion: string | undefined,
    /** Secret + keyfile env so dbt resolves env_var() at profile load. */
    private readonly connectionEnv: Record<string, string>,
  ) {}

  private ensureStarted(): ChildProcess {
    if (this.child && !this.child.killed && this.child.exitCode === null) {
      return this.child;
    }

    const { bin, prefixArgs } = resolveDbtEnginePython(
      this.adapterPackage,
      this.dbtVersion,
      ENGINE_SCRIPT,
    );

    // stdio: [stdin, stdout, stderr, protocol]. dbt logs flow to stdout/stderr
    // (captured for debug); structured responses arrive on fd 3.
    const child = spawn(bin, prefixArgs, {
      stdio: ["pipe", "pipe", "pipe", "pipe"],
      env: {
        ...process.env,
        ...this.connectionEnv,
        DBT_SEND_ANONYMOUS_USAGE_STATS: "false",
      },
    });

    const protocol = child.stdio[3] as NodeJS.ReadableStream;
    protocol.setEncoding("utf8");
    protocol.on("data", chunk => this.onProtocolData(chunk as string));

    child.stderr?.on("data", (data: Buffer) => {
      logger.debug("dbt-engine stderr", {
        adapter: this.adapterPackage,
        line: data.toString("utf8").trim().slice(0, 500),
      });
    });

    child.on("exit", (code, signal) => {
      this.failAllPending(
        new Error(`dbt engine exited (code=${code} signal=${signal})`),
      );
      this.child = null;
      this.buffer = "";
    });
    child.on("error", error => {
      this.failAllPending(error);
      this.child = null;
    });

    this.child = child;
    return child;
  }

  private onProtocolData(chunk: string): void {
    this.buffer += chunk;
    let newline = this.buffer.indexOf("\n");
    while (newline !== -1) {
      const line = this.buffer.slice(0, newline).trim();
      this.buffer = this.buffer.slice(newline + 1);
      if (line) this.handleResponse(line);
      newline = this.buffer.indexOf("\n");
    }
  }

  private handleResponse(line: string): void {
    let message: Record<string, unknown>;
    try {
      message = JSON.parse(line) as Record<string, unknown>;
    } catch {
      logger.warn("dbt-engine: unparseable response", {
        line: line.slice(0, 200),
      });
      return;
    }
    const id = message.id as number | null;
    if (id == null) return;
    const entry = this.pending.get(id);
    if (!entry) return;
    this.pending.delete(id);
    clearTimeout(entry.timer);
    if (message.ok === true) {
      entry.resolve(message);
    } else {
      entry.reject(new Error(String(message.error ?? "dbt engine error")));
    }
  }

  private failAllPending(error: Error): void {
    for (const [, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject(error);
    }
    this.pending.clear();
  }

  request(
    op: string,
    params: Record<string, unknown>,
    timeoutMs = DEFAULT_REQUEST_TIMEOUT_MS,
  ): Promise<Record<string, unknown>> {
    this.lastUsed = Date.now();
    const child = this.ensureStarted();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`dbt engine '${op}' timed out after ${timeoutMs}ms`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      const payload = JSON.stringify({ id, op, ...params }) + "\n";
      child.stdin?.write(payload, error => {
        if (error) {
          this.pending.delete(id);
          clearTimeout(timer);
          reject(error);
        }
      });
    });
  }

  dispose(): void {
    this.failAllPending(new Error("engine disposed"));
    this.child?.kill();
    this.child = null;
  }
}

// Pool keyed by adapter@version@connection. A single process can only serve
// one set of warehouse credentials (env_var() is read at profile load), so the
// key fingerprints the connection env. LRU-evicted to bound memory.
const pool = new Map<string, EngineProcess>();

export interface EngineContext {
  adapterPackage: string;
  dbtVersion?: string;
  /** profile.secretEnv merged with the keyfile env (absolute paths). */
  connectionEnv: Record<string, string>;
}

function poolKey(ctx: EngineContext): string {
  const fingerprint = createHash("sha256")
    .update(JSON.stringify(ctx.connectionEnv))
    .digest("hex")
    .slice(0, 16);
  return `${ctx.adapterPackage}@${ctx.dbtVersion ?? "default"}@${fingerprint}`;
}

function engineFor(ctx: EngineContext): EngineProcess {
  const key = poolKey(ctx);
  let engine = pool.get(key);
  if (!engine) {
    // Evict the least-recently-used process if at capacity.
    if (pool.size >= MAX_ENGINES) {
      let lruKey: string | undefined;
      let lruAt = Infinity;
      for (const [k, e] of pool) {
        if (e.lastUsed < lruAt) {
          lruAt = e.lastUsed;
          lruKey = k;
        }
      }
      if (lruKey) {
        pool.get(lruKey)?.dispose();
        pool.delete(lruKey);
      }
    }
    engine = new EngineProcess(
      ctx.adapterPackage,
      ctx.dbtVersion,
      ctx.connectionEnv,
    );
    pool.set(key, engine);
  }
  return engine;
}

/** Parse the project on disk and cache its manifest for this session. */
export async function enginePrepare(
  ctx: EngineContext,
  session: EngineSession,
): Promise<PreparePayload> {
  const engine = engineFor(ctx);
  const res = await engine.request("prepare", {
    session: session.key,
    project_dir: session.projectDir,
  });
  return { parse_ms: Number(res.parse_ms ?? 0), nodes: Number(res.nodes ?? 0) };
}

/** Compile a model using the warm manifest. */
export async function engineCompile(
  ctx: EngineContext,
  session: EngineSession,
  select: string,
): Promise<CompilePayload> {
  const engine = engineFor(ctx);
  const res = await engine.request("compile", { session: session.key, select });
  return {
    ok: Boolean(res.ok),
    compiled_sql: (res.compiled_sql as string | null) ?? null,
    elapsed_ms: Number(res.elapsed_ms ?? 0),
    error: (res.error as string | null) ?? null,
  };
}

/** Preview rows for a model or inline SQL using the warm manifest. */
export async function engineShow(
  ctx: EngineContext,
  session: EngineSession,
  args: { select?: string; inline?: string; limit?: number },
): Promise<ShowPayload> {
  const engine = engineFor(ctx);
  const res = await engine.request("show", { session: session.key, ...args });
  return {
    ok: Boolean(res.ok),
    columns: (res.columns as string[]) ?? [],
    rows: (res.rows as unknown[][]) ?? [],
    elapsed_ms: Number(res.elapsed_ms ?? 0),
    error: (res.error as string | null) ?? null,
  };
}

/** Drop the cached manifest (e.g. after a structural change). */
export async function engineInvalidate(
  ctx: EngineContext,
  session: EngineSession,
): Promise<void> {
  const engine = engineFor(ctx);
  await engine.request("invalidate", { session: session.key }, 5_000);
}

/** Tear down all engine processes (process shutdown / tests). */
export function disposeAllEngines(): void {
  for (const [, engine] of pool) engine.dispose();
  pool.clear();
}

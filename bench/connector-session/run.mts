/**
 * Per-batch latency of a boxed connector read: one process per chunk
 * (today's path) against one process per read (CONNECTOR_SESSION_READS).
 *
 * The box is a local Docker container from E2B's own `e2bdev/base` image,
 * capped at 2 vCPU and 2 GiB like the `mako-apps-v2` template. A small
 * provider drives it through `docker exec` with real Unix users, so the API's
 * own code runs unchanged: `SandboxedConnector.fetchEntityChunk`,
 * `sync-box.ts` (runtime install, per-run users, chunk runs) and
 * `session-read.ts` (sessions). The connector is bench G1's synthetic,
 * Close-shaped feed (`bench/g1/connector`), generated in the box.
 *
 * No E2B account, no network after the Node download.
 *
 *   cd api
 *   pnpm exec tsx ../bench/connector-session/run.mts
 *   pnpm exec tsx ../bench/connector-session/run.mts --chunks 10 --entities call
 *
 * Options: --chunks 20 (batches per scenario), --entities call,email,
 * --page-delays 0,200 (ms per page, a vendor's latency), --write-delays 0,500
 * (ms the API spends writing each batch), --out <file>.
 */
import { execFile, spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const API = path.join(REPO, "api");
const run = promisify(execFile);

function arg(name: string, fallback: string): string {
  const i = process.argv.indexOf(`--${name}`);
  return i >= 0 && process.argv[i + 1] ? process.argv[i + 1] : fallback;
}
const CHUNKS = Number(arg("chunks", "20"));
const ENTITIES = arg("entities", "call,email").split(",");
const PAGE_DELAYS = arg("page-delays", "0,200").split(",").map(Number);
const WRITE_DELAYS = arg("write-delays", "0,500").split(",").map(Number);
const IMAGE = arg("image", "e2bdev/base:latest");
const DATE = new Date().toISOString().slice(0, 10);
const OUT = arg("out", path.join(HERE, "results", `${DATE}.json`));

process.env.APPS_SANDBOX_PROVIDER = "local";
process.env.NODE_ENV = "development";

// ---------------------------------------------------------------------------
// The box: a container, and a provider that reaches it through docker exec.
// ---------------------------------------------------------------------------
const { stdout: started } = await run("docker", [
  "run",
  "-d",
  "--rm",
  "--init",
  "--cpus",
  "2",
  "--memory",
  "2g",
  IMAGE,
  "sleep",
  "infinity",
]);
const container = started.trim();
const cleanup = async () => {
  await run("docker", ["rm", "-f", container]).catch(() => {});
};
process.on("SIGINT", () => void cleanup().then(() => process.exit(130)));

function dockerExec(
  script: string,
  options: { asRoot?: boolean; timeoutMs?: number; input?: Buffer } = {},
): Promise<{ code: number; stdout: Buffer; stderr: string; ms: number }> {
  const t0 = performance.now();
  return new Promise(resolve => {
    const child = spawn(
      "docker",
      [
        "exec",
        ...(options.input ? ["-i"] : []),
        "-u",
        options.asRoot ? "root" : "user",
        container,
        "bash",
        "-c",
        script,
      ],
      { stdio: ["pipe", "pipe", "pipe"] },
    );
    const out: Buffer[] = [];
    let err = "";
    child.stdout.on("data", d => out.push(d));
    child.stderr.on("data", d => (err += d));
    const timer = setTimeout(
      () => child.kill("SIGKILL"),
      options.timeoutMs ?? 600_000,
    );
    child.on("close", code => {
      clearTimeout(timer);
      resolve({
        code: code ?? 124,
        stdout: Buffer.concat(out),
        stderr: err,
        ms: performance.now() - t0,
      });
    });
    child.stdin.end(options.input ?? undefined);
  });
}

const q = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`;
let calls = 0;
const pinned = (options?: { expectSandboxId?: string }) => {
  if (options?.expectSandboxId && options.expectSandboxId !== container) {
    throw Object.assign(new Error("Sandbox is probably not running anymore"), {
      name: "SandboxNotFoundError",
    });
  }
};

const dockerProvider = {
  id: "local" as const,
  supportsRunUsers: true,
  root: () => "/home/user",
  scratch: () => "/home/user/.scratch",
  async hasSession() {
    return true;
  },
  async exec(_ctx: unknown, command: string, options: any = {}) {
    pinned(options);
    calls++;
    const res = await dockerExec(command, options);
    return {
      exitCode: res.code,
      stdout: res.stdout.toString("utf8"),
      stderr: res.stderr,
      timedOut: res.code === 124,
      durationMs: res.ms,
      truncated: false,
      sandboxId: container,
    };
  },
  async writeFile(
    _ctx: unknown,
    remotePath: string,
    bytes: Uint8Array,
    options: any = {},
  ) {
    pinned(options);
    calls++;
    const res = await dockerExec(
      `mkdir -p "$(dirname ${q(remotePath)})" && cat > ${q(remotePath)}`,
      {
        asRoot: options.asRoot,
        input: Buffer.from(bytes),
      },
    );
    if (res.code !== 0) throw new Error(`write ${remotePath}: ${res.stderr}`);
  },
  /** One request for several files, as E2B's batched write. */
  async writeFiles(
    _ctx: unknown,
    files: Array<{ path: string; bytes: Uint8Array }>,
    options: any = {},
  ) {
    pinned(options);
    calls++;
    const script = files
      .map(
        f =>
          `mkdir -p "$(dirname ${q(f.path)})" && printf %s ${q(Buffer.from(f.bytes).toString("base64"))} | base64 -d > ${q(f.path)}`,
      )
      .join(" && ");
    const res = await dockerExec(script, { asRoot: options.asRoot });
    if (res.code !== 0) throw new Error(`writeFiles: ${res.stderr}`);
  },
  async readFile(_ctx: unknown, remotePath: string, options: any = {}) {
    pinned(options);
    calls++;
    const res = await dockerExec(`cat ${q(remotePath)}`, {
      asRoot: options.asRoot,
    });
    if (res.code !== 0)
      throw new Error(`read ${remotePath}: ${res.stderr.trim()}`);
    return new Uint8Array(res.stdout);
  },
};

const localMod = await import(
  pathToFileURL(path.join(API, "src/apps/sandbox/local-provider.ts")).href
);
Object.assign(localMod.localSandboxProvider, dockerProvider);

const syncBox = await import(
  pathToFileURL(path.join(API, "src/connectors/workspace/sync-box.ts")).href
);
const resolver = await import(
  pathToFileURL(path.join(API, "src/connectors/workspace/resolver.ts")).href
);
const sandboxed = await import(
  pathToFileURL(
    path.join(API, "src/connectors/workspace/SandboxedConnector.ts"),
  ).href
);

// E2B's template user, as in a real box.
await dockerExec("id user >/dev/null 2>&1 || useradd -m -s /bin/bash user", {
  asRoot: true,
});

const ctx = { sessionKey: `connector-sync:v2:bench-session` };
const tInstall = performance.now();
const runtimeId: string = await resolver.ensureConnectorRuntime(ctx);
const installMs = performance.now() - tInstall;
const CONNECTOR_FILES = new Map<string, Uint8Array>(
  ["connector.ts", "connector.yaml"].map(f => [
    f,
    new Uint8Array(fs.readFileSync(path.join(REPO, "bench/g1/connector", f))),
  ]),
);
const SOURCE_SHA = "benchsession01";
const dir: string = await syncBox.materializeConnector({
  ctx,
  runtimeId,
  slug: "bench-close-shaped",
  sourceSha: SOURCE_SHA,
  files: CONNECTOR_FILES,
});
const nodeVersion = (
  await dockerExec(
    `${q(syncBox.connectorRuntimeNodePath(ctx, runtimeId))} -v`,
    { asRoot: true },
  )
).stdout
  .toString()
  .trim();

function makeConnector(config: Record<string, unknown>) {
  const connector = new sandboxed.SandboxedConnector({
    type: "ws:bench-close-shaped",
    workspaceId: "bench",
    config,
  } as any) as any;
  connector.loaded = {
    slug: "bench-close-shaped",
    runtime: "node",
    entry: "connector.ts",
    sha: SOURCE_SHA,
    sourceSha: SOURCE_SHA,
    entities: ["email", "call", "fixed-1k"],
    status: "indexed",
  };
  connector.ready = async () => ({
    dir,
    runtimeId,
    entry: "connector.ts",
    ctx,
  });
  return connector;
}

function pct(values: number[], p: number): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Math.round(
    sorted[
      Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1)
    ],
  );
}

interface Sample {
  /** fetchEntityChunk's own time, the write simulation excluded. */
  ms: number;
  rows: number;
  calls: number;
}

/** CHUNKS chunks of one entity, as the engine runs them. */
async function read(
  mode: "chunk" | "session",
  entity: string,
  pageDelayMs: number,
  writeDelayMs: number,
) {
  process.env.CONNECTOR_SESSION_READS = mode === "session" ? "true" : "false";
  const connector = makeConnector({ pageDelayMs });
  const samples: Sample[] = [];
  let state: any;
  const t0 = performance.now();
  for (let i = 0; i < CHUNKS; i++) {
    let rows = 0;
    let writing = 0;
    const before = calls;
    const s0 = performance.now();
    state = await connector.fetchEntityChunk({
      entity,
      maxIterations: 10,
      state,
      onBatch: async (records: unknown[]) => {
        rows += records.length;
        if (writeDelayMs > 0) {
          const w0 = performance.now();
          await new Promise(r =>
            setTimeout(
              r,
              writeDelayMs / Math.max(1, Math.ceil(1000 / records.length)),
            ),
          );
          writing += performance.now() - w0;
        }
      },
    });
    samples.push({
      ms: performance.now() - s0 - writing,
      rows,
      calls: calls - before,
    });
    if (!state.hasMore) break;
  }
  const totalMs = performance.now() - t0;
  // End the read: a session still open is closed, as a finished read does.
  if (mode === "session" && state?.metadata?.makoSession) {
    const { boxSessionTransport } = await import(
      pathToFileURL(path.join(API, "src/connectors/workspace/session-read.ts"))
        .href
    );
    await boxSessionTransport({
      ctx,
      runtimeId,
      connectorDir: dir,
      onCleanupFailure: () => {},
    }).close(state.metadata.makoSession);
  }
  const later = samples.slice(1).map(s => s.ms);
  return {
    mode,
    entity,
    pageDelayMs,
    writeDelayMs,
    chunks: samples.length,
    rows: samples.reduce((n, s) => n + s.rows, 0),
    firstMs: Math.round(samples[0].ms),
    p50Ms: pct(later, 50),
    p95Ms: pct(later, 95),
    meanMs: Math.round(later.reduce((a, b) => a + b, 0) / later.length),
    callsFirst: samples[0].calls,
    callsLater: pct(
      samples.slice(1).map(s => s.calls),
      50,
    ),
    totalMs: Math.round(totalMs),
  };
}

/** A no-op through the provider: what one call costs this box. */
async function roundTrip() {
  const values: number[] = [];
  for (let i = 0; i < 20; i++) {
    const t0 = performance.now();
    await dockerProvider.exec(ctx, "true", { asRoot: true });
    values.push(performance.now() - t0);
  }
  return { p50Ms: pct(values, 50), p95Ms: pct(values, 95) };
}

const results: Record<string, unknown> = {
  date: new Date().toISOString(),
  image: IMAGE,
  box: "2 vCPU, 2 GiB (docker --cpus 2 --memory 2g)",
  host: `${process.platform} ${process.arch}, Node ${process.versions.node}`,
  connectorNode: nodeVersion,
  runtimeInstallMs: Math.round(installMs),
  chunksPerScenario: CHUNKS,
  roundTrip: await roundTrip(),
  scenarios: [] as unknown[],
};

try {
  for (const entity of ENTITIES) {
    for (const pageDelayMs of PAGE_DELAYS) {
      for (const writeDelayMs of WRITE_DELAYS) {
        for (const mode of ["chunk", "session"] as const) {
          const r = await read(mode, entity, pageDelayMs, writeDelayMs);
          (results.scenarios as unknown[]).push(r);
          console.log(JSON.stringify(r));
        }
      }
    }
  }
  // Nothing of any run is left in the box.
  const left = await dockerExec(
    `ls /var/lib/mako-connectors/sessions /var/lib/mako-connectors/runs 2>/dev/null; awk -F: '$3 >= 200000 { print $1 }' /etc/passwd`,
    { asRoot: true },
  );
  results.leftInBox = left.stdout.toString().trim().split("\n").filter(Boolean);
} finally {
  await cleanup();
}
fs.mkdirSync(path.dirname(OUT), { recursive: true });
fs.writeFileSync(OUT, `${JSON.stringify(results, null, 2)}\n`);
console.log(`wrote ${OUT}`);
process.exit(0);

/**
 * G1: E2B box overhead for connector chunks (rfcs/connector-runtime.md §10).
 *
 * Measures, against E2B with the local-development key:
 *   create     cold box create from the apps template, to first command
 *   pause      pause -> resume (connect) -> first command
 *   snapshot   createSnapshot of a box with the runtime installed, then
 *              Sandbox.create(snapshotId) -> first command; and fork()
 *   exec       a no-op through the provider (what sync-box.ts pays) and raw
 *   chunk      one chunk end to end through SandboxedConnector.fetchEntityChunk
 *              (write config -> exec read -> bounded read-back -> parse ->
 *              onBatch), against the same chunk in-process and in a local
 *              subprocess; with a per-call breakdown of provider round trips
 *   parallel   rows per second for 1, 2 and 4 boxes in parallel
 *   lean       the same chunk in 2 or 3 round trips on a held handle, to
 *              show what a lease-shaped sync-box.ts would cost
 *   metrics    peak RSS and CPU time of one chunk inside the box, and E2B's
 *              own CPU/memory metrics while chunks run
 *
 * Every box this script creates is tagged and killed in a `finally`, and a
 * final sweep kills anything left with the run's tag. Snapshots are deleted.
 *
 * WARNING: never run this against an E2B team that serves live app sessions.
 * Boxes count against one concurrent-sandbox cap; see README.md.
 *
 * Run from the repo root:
 *   pnpm --filter api exec tsx ../bench/g1/run.mts --env-file ../../mako/.env
 * Options: --phases create,pause,snapshot,exec,chunk,lean,parallel,metrics
 *          --n 20  (samples per latency phase)  --chunks 30  --out <file>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const API = path.join(REPO, "api");
const requireFromApi = createRequire(path.join(API, "package.json"));

// ---------------------------------------------------------------------------
// Args and environment. Only the two E2B variables are read from the env file;
// nothing is printed but their presence.
// ---------------------------------------------------------------------------
const argv = process.argv.slice(2);
function arg(name: string, fallback?: string): string | undefined {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
}
const envFile = arg("env-file");
if (envFile) {
  for (const line of fs.readFileSync(envFile, "utf8").split("\n")) {
    const m = line.match(/^(E2B_API_KEY|APPS_E2B_TEMPLATE)=(.*)$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^"|"$/g, "");
  }
}
if (!process.env.E2B_API_KEY) {
  console.error("E2B_API_KEY is missing. Pass --env-file <path to .env> or export it.");
  process.exit(2);
}
process.env.APPS_SANDBOX_PROVIDER = "e2b";
const TEMPLATE = process.env.APPS_E2B_TEMPLATE?.trim() || "base";
const PHASES = (arg("phases", "create,pause,snapshot,exec,chunk,lean,parallel,metrics") as string).split(",");
const N = Number(arg("n", "20"));
const CHUNKS = Number(arg("chunks", "30"));
const RUN_ID = `g1-${Date.now().toString(36)}`;
const OUT = arg("out", path.join(HERE, "results", `${RUN_ID}.json`)) as string;
const TAG = { benchG1: RUN_ID };

const e2b = requireFromApi("e2b") as typeof import("e2b");
const { Sandbox } = e2b;
const E2B_VERSION = requireFromApi("e2b/package.json").version as string;
const apiKey = process.env.E2B_API_KEY as string;

// ---------------------------------------------------------------------------
// Bookkeeping: every box and snapshot this run makes.
// ---------------------------------------------------------------------------
const created = new Set<string>();
const killed = new Set<string>();
const snapshots = new Set<string>();

/**
 * Kill a box, and count it as killed only when E2B confirms it is gone.
 * A failed kill stays out of `killed`, so `boxes.leftRunning` shows the leak.
 */
async function kill(id: string): Promise<void> {
  try {
    // Resolves false when the box was already gone; either way it no longer holds a slot.
    await Sandbox.kill(id, { apiKey });
    killed.add(id);
  } catch (error) {
    if (error instanceof e2b.SandboxNotFoundError) killed.add(id);
    else log(`kill ${id} failed:`, error instanceof Error ? error.message : String(error));
  }
}

// ---------------------------------------------------------------------------
// Headroom. The key's E2B account is shared with live app sessions: on
// 2026-11-16 it capped concurrent sandboxes at 20, and apps held 17-19. Every
// box this script starts takes a slot an app preview may need, so the free
// slots are counted before EVERY box, not once at startup.
// ---------------------------------------------------------------------------
const ACCOUNT_CAP = Number(arg("account-cap", "20"));
/** Never leave fewer free slots than this for app sessions. */
const FLOOR = Number(arg("floor", "3"));

async function runningCount(): Promise<number> {
  let running = 0;
  const paginator = Sandbox.list({ apiKey, query: { state: ["running"] }, limit: 100 });
  while (paginator.hasNext) running += (await paginator.nextItems()).length;
  return running;
}

/** Throw (ending the phase) unless `need` more boxes leave at least FLOOR slots free. */
async function ensureHeadroom(need = 1): Promise<void> {
  const free = ACCOUNT_CAP - (await runningCount());
  if (free - need < FLOOR) {
    throw new Error(`Stopped: ${free} free sandbox slots of ${ACCOUNT_CAP}; starting ${need} more would leave fewer than ${FLOOR} for app sessions.`);
  }
}

async function createBox(template = TEMPLATE): Promise<{ box: any; ms: number }> {
  await ensureHeadroom();
  const t0 = performance.now();
  const box = await Sandbox.create(template, {
    apiKey,
    timeoutMs: 10 * 60_000,
    metadata: TAG,
    // Kill, not pause, if this script dies: a crash must not leave paused boxes.
    lifecycle: { onTimeout: "kill" },
  });
  const ms = performance.now() - t0;
  created.add(box.sandboxId);
  return { box, ms };
}

async function firstCommand(box: any): Promise<number> {
  const t0 = performance.now();
  await box.commands.run("true", { user: "user" });
  return performance.now() - t0;
}

// ---------------------------------------------------------------------------
// Stats
// ---------------------------------------------------------------------------
function pct(values: number[], p: number): number {
  if (values.length === 0) return NaN;
  const s = [...values].sort((a, b) => a - b);
  const i = Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1));
  return s[i];
}
function stats(values: number[]) {
  const r = (x: number) => Math.round(x * 10) / 10;
  return {
    n: values.length,
    p50: r(pct(values, 50)),
    p95: r(pct(values, 95)),
    p99: r(pct(values, 99)),
    min: r(Math.min(...values)),
    max: r(Math.max(...values)),
    mean: r(values.reduce((a, b) => a + b, 0) / Math.max(1, values.length)),
  };
}

const results: Record<string, unknown> = {
  runId: RUN_ID,
  date: new Date().toISOString(),
  e2bSdkVersion: E2B_VERSION,
  template: TEMPLATE,
  host: {
    platform: `${os.platform()} ${os.release()} ${os.arch()}`,
    cpus: os.cpus()[0]?.model,
    node: process.version,
  },
  params: { n: N, chunks: CHUNKS, pageSize: 100, maxIterations: 10 },
};
function save() {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
}
function log(...a: unknown[]) {
  console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);
}

// ---------------------------------------------------------------------------
// The code under test: Mako's own sync box and adapter.
// ---------------------------------------------------------------------------
const providerMod = await import(pathToFileURL(path.join(API, "src/apps/sandbox/e2b-provider.ts")).href);
const localMod = await import(pathToFileURL(path.join(API, "src/apps/sandbox/local-provider.ts")).href);
const syncBox = await import(pathToFileURL(path.join(API, "src/connectors/workspace/sync-box.ts")).href);
const resolver = await import(pathToFileURL(path.join(API, "src/connectors/workspace/resolver.ts")).href);
const sandboxed = await import(pathToFileURL(path.join(API, "src/connectors/workspace/SandboxedConnector.ts")).href);
const provider = providerMod.e2bSandboxProvider as any;

// Per-call timings of provider round trips, so a chunk can be broken down.
let trace: Array<{ op: string; ms: number }> | null = null;
for (const target of [provider, localMod.localSandboxProvider]) {
  for (const op of ["exec", "writeFile", "readFile"] as const) {
    const original = target[op].bind(target);
    target[op] = async (...args: any[]) => {
      const t0 = performance.now();
      try {
        return await original(...args);
      } finally {
        trace?.push({
          op: op === "exec" ? `exec:${String(args[1]).trim().split(/\s+/)[0].replace(/^'|'$/g, "").split("/").pop()}` : op,
          ms: performance.now() - t0,
        });
      }
    };
  }
}

const CONNECTOR_FILES = new Map<string, Uint8Array>(
  ["connector.ts", "connector.yaml"].map(f => [f, new Uint8Array(fs.readFileSync(path.join(HERE, "connector", f)))]),
);
const SOURCE_SHA = (await import("node:crypto"))
  .createHash("sha256")
  .update(CONNECTOR_FILES.get("connector.ts") as Uint8Array)
  .digest("hex")
  .slice(0, 12);

/** Prepare a sync box (provider-managed, keyed like production) and return its ctx. */
async function prepareSyncBox(key: string) {
  const ctx = { sessionKey: `connector-sync:${RUN_ID}-${key}` };
  // The provider creates the box on first use; check room before it does.
  if (!(await provider.hasSession(ctx))) await ensureHeadroom();
  const runtimeId: string = await resolver.ensureConnectorRuntime(ctx);
  const dir: string = await syncBox.materializeConnector({
    ctx,
    runtimeId,
    slug: "bench-close-shaped",
    sourceSha: SOURCE_SHA,
    files: CONNECTOR_FILES,
  });
  const info = await provider.describe(ctx);
  if (info?.sandboxId) created.add(info.sandboxId);
  return { ctx, runtimeId, dir, sandboxId: info?.sandboxId as string };
}

/** A SandboxedConnector wired to a prepared box, bypassing only the Mongo lookup. */
function makeConnector(prepared: { ctx: any; runtimeId: string; dir: string }, config: Record<string, unknown> = {}) {
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
  connector.ready = async () => ({ dir: prepared.dir, runtimeId: prepared.runtimeId, entry: "connector.ts", ctx: prepared.ctx });
  return connector;
}

/** One chunk through the adapter, with its breakdown. */
async function boxedChunk(connector: any, entity: string, offset: number) {
  trace = [];
  let rows = 0;
  const t0 = performance.now();
  const state = await connector.fetchEntityChunk({
    entity,
    maxIterations: 10,
    state: offset > 0 ? { totalProcessed: offset, hasMore: true, metadata: { type: "STREAM", stream: { stream_descriptor: { name: entity }, stream_state: { offset } } } } : undefined,
    onBatch: async (records: unknown[]) => {
      rows += records.length;
    },
  });
  const ms = performance.now() - t0;
  const calls = trace;
  trace = null;
  return { ms, rows, state, calls };
}

/** The same chunk in the API process: the connector's generator, no box, no subprocess. */
async function inProcessChunk(entity: string, offset: number) {
  const runtimeRoot = localRuntimeDir as string;
  const mod = await import(pathToFileURL(path.join(runtimeRoot, "connector.ts")).href);
  const { createContext } = await import(pathToFileURL(path.join(REPO, "packages/connector-sdk/src/define.js")).href);
  const connector = mod.default;
  const ctx = createContext({ config: {}, state: { offset }, log: () => {}, entity });
  const t0 = performance.now();
  let rows = 0;
  let pages = 0;
  for await (const batch of connector.entity(entity).read(ctx, { offset })) {
    rows += batch.records.length;
    pages++;
    if (pages >= 10) break;
  }
  return { ms: performance.now() - t0, rows };
}
let localRuntimeDir: string | null = null;

// ---------------------------------------------------------------------------
// Phases
// ---------------------------------------------------------------------------
async function phaseCreate() {
  log(`create: ${N} cold boxes from template "${TEMPLATE}"`);
  const createMs: number[] = [];
  const firstMs: number[] = [];
  const totalMs: number[] = [];
  for (let i = 0; i < N; i++) {
    const { box, ms } = await createBox();
    const f = await firstCommand(box);
    if (i === 0) {
      const info = await box.getInfo();
      results.boxSize = { cpuCount: info.cpuCount, memoryMB: info.memoryMB, template: TEMPLATE };
    }
    createMs.push(ms);
    firstMs.push(f);
    totalMs.push(ms + f);
    await kill(box.sandboxId);
  }
  results.create = { createMs: stats(createMs), firstCommandMs: stats(firstMs), createToFirstCommandMs: stats(totalMs) };
  log("create", results.create);
}

async function phasePause() {
  log(`pause: ${N} pause -> resume cycles on one box`);
  const { box } = await createBox();
  try {
    // Something resident, so a memory snapshot is not trivially empty.
    await box.commands.run("node -e \"globalThis.x=Buffer.alloc(64*1024*1024,1);setInterval(()=>{},1e6)\" >/dev/null 2>&1 &", { user: "user" });
    const pauseMs: number[] = [];
    const resumeMs: number[] = [];
    const firstMs: number[] = [];
    for (let i = 0; i < N; i++) {
      let t0 = performance.now();
      await Sandbox.pause(box.sandboxId, { apiKey });
      pauseMs.push(performance.now() - t0);
      t0 = performance.now();
      const resumed = await Sandbox.connect(box.sandboxId, { apiKey, timeoutMs: 10 * 60_000 });
      resumeMs.push(performance.now() - t0);
      firstMs.push(await firstCommand(resumed));
    }
    results.pause = {
      pauseMs: stats(pauseMs),
      resumeMs: stats(resumeMs),
      firstCommandAfterResumeMs: stats(firstMs),
      resumeToFirstCommandMs: stats(resumeMs.map((r, i) => r + firstMs[i])),
    };
    log("pause", results.pause);
  } finally {
    await kill(box.sandboxId);
  }
}

async function phaseSnapshot() {
  log(`snapshot: a box with the runtime + connector, snapshotted, restored ${N} times; fork ${Math.min(N, 10)} times`);
  const prepared = await prepareSyncBox("snapsrc");
  const source = await Sandbox.connect(prepared.sandboxId, { apiKey });
  let snapshotId: string | null = null;
  try {
    let t0 = performance.now();
    const snap = await source.createSnapshot({ name: `mako-g1-${RUN_ID}` } as any);
    const snapshotMs = performance.now() - t0;
    snapshotId = snap.snapshotId;
    snapshots.add(snap.snapshotId);
    const restoreMs: number[] = [];
    const firstMs: number[] = [];
    const firstChunkMs: number[] = [];
    for (let i = 0; i < N; i++) {
      const { box, ms } = await createBox(snap.snapshotId);
      restoreMs.push(ms);
      firstMs.push(await firstCommand(box));
      // A restored box must already hold the runtime: run a 1-page read
      // directly (not through the provider, which keys boxes by session).
      t0 = performance.now();
      const bin = path.posix.join(prepared.dir, "../../node_modules/@makoai/connector-sdk/bin/mako-connector.js");
      const node = path.posix.join(prepared.dir, "../../node/bin/node");
      const r = await box.commands.run(
        `echo '{}' > /tmp/c.json && echo '{"streams":[{"stream":{"name":"call"}}]}' > /tmp/k.json && ${node} ${bin} read --connector ${prepared.dir}/connector.ts --config /tmp/c.json --catalog /tmp/k.json --max-iterations 1 | tail -1`,
        { user: "user" },
      );
      if (!r.stdout.includes('"STATE"')) throw new Error(`restored box could not run the connector: ${r.stderr.slice(0, 300)}`);
      firstChunkMs.push(performance.now() - t0);
      await kill(box.sandboxId);
    }
    const forkMs: number[] = [];
    const forkFirstMs: number[] = [];
    let forkError: string | null = null;
    for (let i = 0; i < Math.min(N, 10); i++) {
      try {
        await ensureHeadroom();
        t0 = performance.now();
        const [fork] = await (source as any).fork({ count: 1, timeoutMs: 5 * 60_000 });
        const ms = performance.now() - t0;
        if (fork instanceof Error) throw fork;
        created.add(fork.sandboxId);
        forkMs.push(ms);
        forkFirstMs.push(await firstCommand(fork));
        await kill(fork.sandboxId);
      } catch (error) {
        forkError = error instanceof Error ? error.message : String(error);
        break;
      }
    }
    results.snapshot = {
      createSnapshotMs: Math.round(snapshotMs),
      restoreCreateMs: stats(restoreMs),
      restoreFirstCommandMs: stats(firstMs),
      restoreToFirstCommandMs: stats(restoreMs.map((r, i) => r + firstMs[i])),
      oneRowPageReadAfterRestoreMs: stats(firstChunkMs),
      fork: forkMs.length ? { forkMs: stats(forkMs), forkToFirstCommandMs: stats(forkMs.map((r, i) => r + forkFirstMs[i])) } : null,
      forkError,
    };
    log("snapshot", results.snapshot);
  } finally {
    if (snapshotId) {
      await Sandbox.deleteSnapshot(snapshotId, { apiKey }).catch(() => undefined);
      snapshots.delete(snapshotId);
    }
    await kill(prepared.sandboxId);
    await provider.destroySession(prepared.ctx.sessionKey);
  }
}

let warm: Awaited<ReturnType<typeof prepareSyncBox>> | null = null;
async function warmBox() {
  if (!warm) warm = await prepareSyncBox("warm");
  return warm;
}

async function phaseExec() {
  const W = await warmBox();
  const n = Math.max(N, 50);
  log(`exec: ${n} no-op commands through the provider and raw`);
  const viaProvider: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await provider.exec(W.ctx, "true", { timeoutMs: 30_000 });
    viaProvider.push(performance.now() - t0);
  }
  const box = await Sandbox.connect(W.sandboxId, { apiKey });
  const raw: number[] = [];
  for (let i = 0; i < n; i++) raw.push(await firstCommand(box));
  const connect: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await Sandbox.connect(W.sandboxId, { apiKey });
    connect.push(performance.now() - t0);
  }
  const write: number[] = [];
  for (let i = 0; i < n; i++) {
    const t0 = performance.now();
    await box.files.write("/home/user/g1-small.json", '{"a":1}', { user: "user" });
    write.push(performance.now() - t0);
  }
  results.exec = {
    providerExecNoopMs: stats(viaProvider),
    rawCommandNoopMs: stats(raw),
    sandboxConnectMs: stats(connect),
    rawSmallFileWriteMs: stats(write),
  };
  log("exec", results.exec);
}

async function phaseChunk() {
  const W = await warmBox();
  // Local subprocess baseline: same adapter, same runConnectorCommand, local provider.
  // getSandboxProvider() reads this variable on every call, so it is put back
  // in a `finally`: a throw here must not leave later phases on the laptop.
  try {
    await chunkBody(W);
  } finally {
    process.env.APPS_SANDBOX_PROVIDER = "e2b";
  }
}

async function chunkBody(W: Awaited<ReturnType<typeof prepareSyncBox>>) {
  process.env.APPS_SANDBOX_PROVIDER = "local";
  const localCtx = { sessionKey: `connector-sync:${RUN_ID}-local` };
  const localRuntime: string = await resolver.ensureConnectorRuntime(localCtx);
  const localDir: string = await syncBox.materializeConnector({ ctx: localCtx, runtimeId: localRuntime, slug: "bench-close-shaped", sourceSha: SOURCE_SHA, files: CONNECTOR_FILES });
  localRuntimeDir = localDir;
  const localConnector = makeConnector({ ctx: localCtx, runtimeId: localRuntime, dir: localDir });
  const out: Record<string, unknown> = {};
  for (const entity of ["fixed-1k", "call", "email"]) {
    log(`chunk: ${CHUNKS} chunks of "${entity}" in-process, local subprocess, and boxed`);
    const inproc: number[] = [];
    for (let i = 0; i < CHUNKS; i++) inproc.push((await inProcessChunk(entity, i * 1000)).ms);

    process.env.APPS_SANDBOX_PROVIDER = "local";
    const local: number[] = [];
    let localOverCap = 0;
    for (let i = 0; i < CHUNKS; i++) {
      try {
        local.push((await boxedChunk(localConnector, entity, i * 1000)).ms);
      } catch (error) {
        if (/byte limit/.test(String((error as Error)?.message))) localOverCap++;
        else throw error;
      }
    }

    process.env.APPS_SANDBOX_PROVIDER = "e2b";
    const connector = makeConnector(W);
    const boxed: number[] = [];
    const readExec: number[] = [];
    const rest: number[] = [];
    const breakdown: Record<string, number[]> = {};
    let rows = 0;
    let bytesErrors = 0;
    for (let i = 0; i < CHUNKS; i++) {
      try {
        const r = await boxedChunk(connector, entity, i * 1000);
        boxed.push(r.ms);
        rows += r.rows;
        for (const c of r.calls) (breakdown[c.op] ??= []).push(c.ms);
        // The `read` itself is the exec whose first token is the runtime's node.
        const read = r.calls.find(c => c.op === "exec:node")?.ms ?? 0;
        readExec.push(read);
        rest.push(r.ms - read);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        if (/byte limit/.test(message)) bytesErrors++;
        else throw error;
      }
    }
    const ip = stats(inproc);
    const bx = stats(boxed);
    out[entity] = {
      rowsPerChunk: 1000,
      inProcessMs: ip,
      localSubprocessMs: stats(local),
      boxedMs: bx,
      boxedReadExecMs: stats(readExec),
      boxedOtherRoundTripsMs: stats(rest),
      overheadVsInProcessMs: { p50: Math.round(bx.p50 - ip.p50), p95: Math.round(bx.p95 - ip.p95), p99: Math.round(bx.p99 - ip.p99) },
      providerCallsPerChunk: Object.fromEntries(Object.entries(breakdown).map(([k, v]) => [k, { perChunk: Math.round((v.length / Math.max(1, boxed.length)) * 10) / 10, ...stats(v) }])),
      boxedRowsPerSecond: Math.round(rows / (boxed.reduce((a, b) => a + b, 0) / 1000)),
      chunksOverByteCap: { boxed: bytesErrors, local: localOverCap, of: CHUNKS },
    };
    log(entity, JSON.stringify(out[entity]).slice(0, 600));
    results.chunk = out;
    save();
  }
  results.chunk = out;
}

async function phaseParallel() {
  const out: Record<string, unknown> = {};
  const boxes: Array<Awaited<ReturnType<typeof prepareSyncBox>>> = [await warmBox()];
  for (let i = 1; i < 4; i++) boxes.push(await prepareSyncBox(`par${i}`));
  for (const entity of ["call", "email"]) {
    for (const k of [1, 2, 4]) {
      log(`parallel: ${k} box(es), ${CHUNKS} chunks each of "${entity}"`);
      const t0 = performance.now();
      const perChunk: number[] = [];
      let rows = 0;
      let failed = 0;
      await Promise.all(
        boxes.slice(0, k).map(async (b, bi) => {
          const connector = makeConnector(b);
          for (let i = 0; i < CHUNKS; i++) {
            try {
              const r = await boxedChunk(connector, entity, (bi * CHUNKS + i) * 1000);
              perChunk.push(r.ms);
              rows += r.rows;
            } catch {
              failed++;
            }
          }
        }),
      );
      const wall = (performance.now() - t0) / 1000;
      out[`${entity}:${k}`] = { boxes: k, wallS: Math.round(wall * 10) / 10, rows, rowsPerSecond: Math.round(rows / wall), chunkMs: stats(perChunk), failed };
      log(`${entity}:${k}`, out[`${entity}:${k}`]);
    }
  }
  results.parallel = out;
  for (const b of boxes.slice(1)) await provider.destroySession(b.ctx.sessionKey);
}

async function phaseMetrics() {
  const W = await warmBox();
  const box = await Sandbox.connect(W.sandboxId, { apiKey });
  const node = path.posix.join(W.dir, "../../node/bin/node");
  const bin = path.posix.join(W.dir, "../../node_modules/@makoai/connector-sdk/bin/mako-connector.js");
  const out: Record<string, unknown> = {};
  // Peak RSS and CPU time of one chunk's process, from Node's own rusage at exit.
  await box.files.write(
    "/tmp/g1-rusage.cjs",
    `process.on("exit",()=>{const u=process.resourceUsage();require("fs").writeFileSync("/tmp/g1-rusage.json",JSON.stringify({maxRSS:u.maxRSS,user:u.userCPUTime,system:u.systemCPUTime}))})`,
    { user: "user" },
  );
  for (const entity of ["call", "email"]) {
    const t0 = performance.now();
    const r = await box.commands.run(
      `echo '{}' > /tmp/c.json && echo '{"streams":[{"stream":{"name":"${entity}"}}]}' > /tmp/k.json && ` +
        `${node} --require /tmp/g1-rusage.cjs ${bin} read --connector ${W.dir}/connector.ts --config /tmp/c.json --catalog /tmp/k.json --max-iterations 10 > /tmp/o.jsonl && ` +
        `cat /tmp/g1-rusage.json && echo && wc -c < /tmp/o.jsonl`,
      { user: "user" },
    );
    const wallMs = performance.now() - t0;
    const [json, bytes] = r.stdout.trim().split("\n");
    const u = JSON.parse(json);
    const cpuMs = (u.user + u.system) / 1000;
    out[entity] = {
      peakRssMB: Math.round(u.maxRSS / 1024),
      cpuMs: Math.round(cpuMs),
      commandWallMs: Math.round(wallMs),
      protocolBytes: Number(bytes),
    };
  }
  // E2B's own sampled metrics over a burst of email chunks.
  const connector = makeConnector(W);
  const since = new Date();
  for (let i = 0; i < 20; i++) await boxedChunk(connector, "email", 500_000 + i * 1000).catch(() => undefined);
  await new Promise(r => setTimeout(r, 6000));
  const metrics = await Sandbox.getMetrics(W.sandboxId, { apiKey, start: since }).catch((e: Error) => e.message);
  if (Array.isArray(metrics) && metrics.length > 0) {
    out.e2bMetricsDuringEmailChunks = {
      samples: metrics.length,
      cpuCount: metrics[0].cpuCount,
      memTotalMB: Math.round(metrics[0].memTotal / 1048576),
      cpuUsedPctMax: Math.round(Math.max(...metrics.map(m => m.cpuUsedPct))),
      cpuUsedPctMean: Math.round(metrics.reduce((a, m) => a + m.cpuUsedPct, 0) / metrics.length),
      memUsedMBMax: Math.round(Math.max(...metrics.map(m => m.memUsed)) / 1048576),
    };
  } else out.e2bMetricsDuringEmailChunks = metrics;
  results.metrics = out;
  log("metrics", out);
}

/**
 * The same chunk with the round trips a lease could keep: one Sandbox handle
 * held for the run (no connect, no setTimeout per call), the three input files
 * in one write, and read + bound + cleanup in one command. Two variants:
 *   lean3  write -> exec (read, head -c, rm inputs) -> files.read  (3 round trips)
 *   lean2  write -> exec that streams the bounded output on stdout  (2 round trips)
 * Parsing is the same as runConnectorCommand's. Not product code: it shows
 * what sync-box.ts would cost if it were built around a lease.
 */
async function phaseLean() {
  const W = await warmBox();
  const box = await Sandbox.connect(W.sandboxId, { apiKey });
  const node = path.posix.join(W.dir, "../../node/bin/node");
  const bin = path.posix.join(W.dir, "../../node_modules/@makoai/connector-sdk/bin/mako-connector.js");
  const cap = syncBox.MAX_CONNECTOR_PROTOCOL_BYTES as number;
  const q = (v: string) => `'${v.replace(/'/g, `'\\''`)}'`;
  const parse = (raw: string) => {
    let rows = 0;
    let state: unknown = null;
    for (const line of raw.split("\n")) {
      if (!line.trim()) continue;
      const m = JSON.parse(line);
      if (m.type === "RECORD") rows++;
      else if (m.type === "STATE") state = m.state;
    }
    return { rows, state };
  };
  const out: Record<string, unknown> = {};
  for (const entity of ["fixed-1k", "call", "email"]) {
    for (const variant of ["lean3", "lean2"] as const) {
      log(`lean: ${CHUNKS} chunks of "${entity}" (${variant})`);
      const ms: number[] = [];
      let rows = 0;
      let overCap = 0;
      for (let i = 0; i < CHUNKS; i++) {
        const runDir = `/tmp/connector-runs/lean-${i}-${Date.now().toString(36)}`;
        const offset = 200_000 + i * 1000;
        const t0 = performance.now();
        await box.files.write(
          [
            { path: `${runDir}/config.json`, data: "{}" },
            { path: `${runDir}/catalog.json`, data: JSON.stringify({ streams: [{ stream: { name: entity }, sync_mode: "incremental" }] }) },
            { path: `${runDir}/state.json`, data: JSON.stringify([{ type: "STREAM", stream: { stream_descriptor: { name: entity }, stream_state: { offset } } }]) },
          ],
          { user: "user" },
        );
        const read = `${q(node)} ${q(bin)} read --connector ${q(W.dir + "/connector.ts")} --config ${runDir}/config.json --catalog ${runDir}/catalog.json --state ${runDir}/state.json --max-iterations 10 > ${runDir}/out.jsonl; rm -f ${runDir}/config.json ${runDir}/state.json`;
        let raw = "";
        if (variant === "lean3") {
          const r = await box.commands.run(`${read}; head -c ${cap + 1} ${runDir}/out.jsonl > ${runDir}/b.jsonl; wc -c < ${runDir}/b.jsonl`, { user: "user", timeoutMs: 600_000 });
          if (Number(r.stdout.trim()) > cap) overCap++;
          else raw = new TextDecoder().decode(await box.files.read(`${runDir}/b.jsonl`, { format: "bytes", user: "user" }));
          void box.commands.run(`rm -rf ${runDir}`, { user: "user", background: true }).catch(() => undefined);
        } else {
          const chunks: string[] = [];
          let size = 0;
          await box.commands.run(`${read}; head -c ${cap + 1} ${runDir}/out.jsonl; rm -rf ${runDir}`, {
            user: "user",
            timeoutMs: 600_000,
            onStdout: (d: string) => {
              size += d.length;
              chunks.push(d);
            },
          });
          if (size > cap) overCap++;
          else raw = chunks.join("");
        }
        if (raw) rows += parse(raw).rows;
        ms.push(performance.now() - t0);
      }
      out[`${entity}:${variant}`] = { chunkMs: stats(ms), rows, overCap, rowsPerSecond: Math.round(rows / (ms.reduce((a, b) => a + b, 0) / 1000)) };
      log(`${entity}:${variant}`, out[`${entity}:${variant}`]);
      results.lean = out;
      save();
    }
  }
}

// ---------------------------------------------------------------------------
// Main, with a sweep that kills everything tagged with this run.
// ---------------------------------------------------------------------------
async function sweep() {
  await localMod.localSandboxProvider.destroySession?.(`connector-sync:${RUN_ID}-local`).catch(() => undefined);
  if (warm) await provider.destroySession(warm.ctx.sessionKey).catch(() => undefined);
  for (const id of created) if (!killed.has(id)) await kill(id);
  for (const query of [{ metadata: TAG }, {}]) {
    const paginator = Sandbox.list({ apiKey, query: { ...query, state: ["running", "paused"] } as any, limit: 100 });
    while (paginator.hasNext) {
      for (const box of await paginator.nextItems()) {
        const key = (box.metadata as any)?.makoAppsSessionKey ?? "";
        if ((box.metadata as any)?.benchG1 === RUN_ID || key.startsWith(`connector-sync:${RUN_ID}`) || created.has(box.sandboxId)) {
          created.add(box.sandboxId);
          await kill(box.sandboxId);
        }
      }
    }
  }
  for (const id of snapshots) await Sandbox.deleteSnapshot(id, { apiKey }).catch(() => undefined);
}

const PHASE_FNS: Record<string, () => Promise<void>> = {
  create: phaseCreate,
  pause: phasePause,
  snapshot: phaseSnapshot,
  exec: phaseExec,
  chunk: phaseChunk,
  parallel: phaseParallel,
  metrics: phaseMetrics,
  lean: phaseLean,
};

log(`G1 run ${RUN_ID}: e2b ${E2B_VERSION}, template ${TEMPLATE}, phases ${PHASES.join(",")}`);
const started = performance.now();

// The key's E2B account is shared with live app sessions. On 2026-11-16 it
// capped concurrent sandboxes at 20, and 17-19 were in use by apps. This run
// holds up to 2 boxes (5 with `parallel`), so refuse to start without room.
{
  const minFree = Number(arg("min-free", PHASES.includes("parallel") ? "10" : "6"));
  const running = await runningCount();
  log(`account: ${running} running sandboxes of a ${ACCOUNT_CAP} cap`);
  if (ACCOUNT_CAP - running < minFree) {
    console.error(`Refusing to run: ${ACCOUNT_CAP - running} free slots, need ${minFree}. Use an E2B team that serves no app sessions.`);
    process.exit(3);
  }
}

// Ctrl-C and SIGTERM skip a `finally`. Without these, createBox boxes hold a
// slot for up to 10 minutes and provider-made boxes pause with memory forever.
let finishing: Promise<void> | null = null;
async function finish(code: number): Promise<never> {
  finishing ??= (async () => {
    await sweep();
    results.boxes = { created: created.size, killed: killed.size, leftRunning: [...created].filter(id => !killed.has(id)) };
    results.totalSeconds = Math.round((performance.now() - started) / 1000);
    save();
    log(`boxes created ${created.size}, killed ${killed.size}; results in ${OUT}`);
  })();
  await finishing;
  process.exit(code);
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.once(signal, () => {
    log(`${signal}: killing this run's boxes before exiting`);
    void finish(code);
  });
}
try {
  for (const phase of PHASES) {
    const t0 = performance.now();
    try {
      await PHASE_FNS[phase]();
    } catch (error) {
      results[`${phase}Error`] = error instanceof Error ? `${error.message}\n${error.stack?.split("\n").slice(1, 4).join("\n")}` : String(error);
      log(`${phase} failed:`, results[`${phase}Error`]);
    }
    (results.phaseSeconds ??= {} as any)[phase] = Math.round((performance.now() - t0) / 100) / 10;
    save();
  }
} finally {
  await finish(0);
}

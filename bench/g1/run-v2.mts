/**
 * G1, second run: the connector chunk path after PR 1278 (per-run users and
 * leases) and PR 1284 (3 round trips per chunk, held handles, byte cap).
 *
 * Drives the code as it ships, through SandboxedConnector.fetchEntityChunk:
 *   flag off  CONNECTOR_BOX_LEASES unset: one sync box per workspace
 *   flag on   CONNECTOR_BOX_LEASES=true: a leased box per connection + hash,
 *             through the real BoxScheduler. Its Mongo records are replaced by
 *             MemoryBoxStore (same compare-and-set semantics; the scheduler's
 *             own tests use it), so no database is touched.
 *
 * Phases:
 *   off-warm     chunks in a warm workspace sync box
 *   off-cold     first chunk in a new sync box (create + runtime + folder),
 *                and first chunk after the box was paused (resume)
 *   boot         inside the box: node start, connector import, a full read,
 *                to split a chunk into connector boot and transport
 *   on-warm      chunks on one connection's leased box (first one cold)
 *   on-cold      first chunk of a new connection (fresh box + snapshot),
 *                after a pause (resume), after a kill (restore from template)
 *   parallel     rows per second with 1, 2, 4 and 8 connections (flag on),
 *                and 1, 2, 4 concurrent chunks in one sync box (flag off)
 *
 * Safety. The key's project must serve no users. Every box start is checked
 * against --account-cap (default 10) running boxes on the account; leased
 * boxes use the scheduler's own ceiling, set to the same cap. Every box and
 * snapshot this run makes is killed or deleted in a `finally`, on Ctrl-C and
 * on SIGTERM. Only boxes this run made are touched.
 *
 * Run from api/ with the key in the environment only:
 *   E2B_API_KEY="$(gcloud secrets versions access 2 --secret E2B_API_KEY --project mako-ai-dev)" \
 *   APPS_E2B_TEMPLATE=mako-apps pnpm exec tsx ../bench/g1/run-v2.mts
 * Options: --phases <list> --chunks 30 --n 10 --account-cap 10 --out <file>
 */
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { createHash } from "node:crypto";
import { createRequire } from "node:module";
import { performance } from "node:perf_hooks";
import { fileURLToPath, pathToFileURL } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, "../..");
const API = path.join(REPO, "api");
const requireFromApi = createRequire(path.join(API, "package.json"));

const argv = process.argv.slice(2);
const arg = (name: string, fallback?: string) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : fallback;
};
if (!process.env.E2B_API_KEY) {
  console.error("E2B_API_KEY is missing from the environment.");
  process.exit(2);
}
const apiKey = process.env.E2B_API_KEY;
process.env.APPS_SANDBOX_PROVIDER = "e2b";
process.env.APPS_E2B_TEMPLATE ||= "mako-apps";
const TEMPLATE = process.env.APPS_E2B_TEMPLATE;
const PHASES = (arg("phases", "off-warm,boot,off-cold,on-warm,on-cold,parallel") as string).split(",");
const CHUNKS = Number(arg("chunks", "30"));
const N = Number(arg("n", "10"));
const CAP = Number(arg("account-cap", "10"));
const RUN_ID = `g1v2-${Date.now().toString(36)}`;
const OUT = arg("out", path.join(HERE, "results", `${RUN_ID}.json`)) as string;

// The scheduler's knobs, set before anything reads them.
process.env.CONNECTOR_BOX_ACCOUNT_CEILING = String(CAP);
process.env.CONNECTOR_BOX_APP_RESERVE = "0";
process.env.CONNECTOR_BOX_QUEUE_WAIT_MS = "120000";
process.env.CONNECTOR_BOX_ACCOUNT_COUNT_TTL_MS = "2000";

const e2b = requireFromApi("e2b") as typeof import("e2b");
const { Sandbox } = e2b;
const E2B_VERSION = requireFromApi("e2b/package.json").version as string;
const imp = (p: string) => import(pathToFileURL(path.join(API, p)).href);

const providerMod = await imp("src/apps/sandbox/e2b-provider.ts");
const syncBox = await imp("src/connectors/workspace/sync-box.ts");
const resolver = await imp("src/connectors/workspace/resolver.ts");
const sandboxed = await imp("src/connectors/workspace/SandboxedConnector.ts");
const storeMod = await imp("src/connectors/workspace/boxes/box-store.ts");
const schedulerMod = await imp("src/connectors/workspace/boxes/scheduler.ts");
const provider = providerMod.e2bSandboxProvider as any;

// Mongo records -> MemoryBoxStore, before getBoxScheduler() builds its store.
const memStore = new storeMod.MemoryBoxStore();
for (const name of Object.getOwnPropertyNames(storeMod.MemoryBoxStore.prototype)) {
  if (name === "constructor") continue;
  storeMod.MongoBoxStore.prototype[name] = function (...a: unknown[]) {
    return (memStore as any)[name](...a);
  };
}

// ---------------------------------------------------------------------------
// Bookkeeping and safety
// ---------------------------------------------------------------------------
const sessionKeys = new Set<string>();
const sandboxIds = new Set<string>();
const killedIds = new Set<string>();
const snapshotIds = new Set<string>();

async function runningCount(): Promise<number> {
  let n = 0;
  const p = Sandbox.list({ apiKey, query: { state: ["running"] }, limit: 100 });
  while (p.hasNext) n += (await p.nextItems()).length;
  return n;
}
async function ensureHeadroom(need = 1) {
  const running = await runningCount();
  if (running + need > CAP) throw new Error(`Stopped: ${running} running boxes; ${need} more would pass the ${CAP}-box cap.`);
}

// Per-call timings of provider round trips.
let trace: Array<{ op: string; ms: number }> | null = null;
const classify = (cmd: string) =>
  cmd === "true"
    ? "exec:ping"
    : cmd.includes("mako-connector.js")
      ? "exec:chunk"
      : cmd.includes("nodejs.org")
        ? "exec:install-node"
        : cmd.includes(".materialized")
          ? "exec:marker-check"
          : cmd.includes("rm -rf") || cmd.includes("rm -f")
            ? "exec:rm"
            : "exec:other";
for (const op of ["exec", "writeFile", "writeFiles", "readFile"] as const) {
  const original = provider[op].bind(provider);
  provider[op] = async (...args: any[]) => {
    const ctx = args[0];
    if (ctx?.sessionKey) sessionKeys.add(ctx.sessionKey);
    const t0 = performance.now();
    try {
      return await original(...args);
    } finally {
      trace?.push({ op: op === "exec" ? classify(String(args[1])) : op, ms: performance.now() - t0 });
    }
  };
}
for (const op of ["create", "pause", "snapshot"] as const) {
  const original = provider.boxLifecycle[op].bind(provider.boxLifecycle);
  provider.boxLifecycle[op] = async (...args: any[]) => {
    if (op === "create") {
      await ensureHeadroom();
      sessionKeys.add(args[0]);
    }
    const t0 = performance.now();
    try {
      const r = await original(...args);
      if (op === "snapshot" && r) snapshotIds.add(r);
      return r;
    } finally {
      trace?.push({ op: `lifecycle:${op}`, ms: performance.now() - t0 });
    }
  };
}

// ---------------------------------------------------------------------------
// Stats and results
// ---------------------------------------------------------------------------
function pct(v: number[], p: number) {
  if (!v.length) return NaN;
  const s = [...v].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.max(0, Math.ceil((p / 100) * s.length) - 1))];
}
const r1 = (x: number) => Math.round(x * 10) / 10;
function stats(v: number[]) {
  return { n: v.length, p50: r1(pct(v, 50)), p95: r1(pct(v, 95)), p99: r1(pct(v, 99)), min: r1(Math.min(...v)), max: r1(Math.max(...v)), mean: r1(v.reduce((a, b) => a + b, 0) / Math.max(1, v.length)) };
}
const results: Record<string, any> = {
  runId: RUN_ID,
  date: new Date().toISOString(),
  e2bSdkVersion: E2B_VERSION,
  template: TEMPLATE,
  accountCap: CAP,
  host: { platform: `${os.platform()} ${os.release()} ${os.arch()}`, cpus: os.cpus()[0]?.model, node: process.version },
  params: { chunks: CHUNKS, n: N, pageSize: 100, maxIterations: 10, maxBytes: sandboxed.CHUNK_BYTE_BUDGET },
};
const save = () => {
  fs.mkdirSync(path.dirname(OUT), { recursive: true });
  fs.writeFileSync(OUT, JSON.stringify(results, null, 2));
};
const log = (...a: unknown[]) => console.log(`[${new Date().toISOString().slice(11, 19)}]`, ...a);

// ---------------------------------------------------------------------------
// The connector under test
// ---------------------------------------------------------------------------
const FILES = new Map<string, Uint8Array>(
  ["connector.ts", "connector.yaml"].map(f => [f, new Uint8Array(fs.readFileSync(path.join(HERE, "connector", f)))]),
);
const SHA = createHash("sha256").update(FILES.get("connector.ts") as Uint8Array).digest("hex").slice(0, 12);
const LOADED = {
  slug: "bench-close-shaped",
  runtime: "node",
  entry: "connector.ts",
  sha: SHA,
  sourceSha: SHA,
  entities: ["email", "call", "fixed-1k"],
  status: "indexed",
};

function makeConnector(input: { workspaceId: string; connectionId: string; prepared?: Prepared }) {
  const c = new sandboxed.SandboxedConnector({
    _id: input.connectionId,
    type: "ws:bench-close-shaped",
    workspaceId: input.workspaceId,
    config: {},
    settings: {},
  } as any) as any;
  // Only the Mongo/git lookups are bypassed; run() and the box path are real.
  c.loaded = LOADED;
  c.definition = async () => LOADED;
  c.folder = async () => FILES;
  if (input.prepared) {
    const p = input.prepared;
    c.ready = async () => ({ dir: p.dir, runtimeId: p.runtimeId, entry: "connector.ts", ctx: p.ctx });
  }
  return c;
}

interface Prepared { ctx: { sessionKey: string }; runtimeId: string; dir: string; sandboxId?: string }

/** Flag off: a workspace sync box, as SandboxedConnector.ready() builds it. */
async function prepareSyncBox(workspaceId: string): Promise<Prepared> {
  const ctx = syncBox.syncBoxContext(workspaceId);
  sessionKeys.add(ctx.sessionKey);
  if (!(await provider.hasSession(ctx))) await ensureHeadroom();
  const runtimeId: string = await resolver.ensureConnectorRuntime(ctx);
  const dir: string = await syncBox.materializeConnector({ ctx, runtimeId, slug: LOADED.slug, sourceSha: SHA, files: FILES });
  const info = await provider.describe(ctx);
  if (info?.sandboxId) sandboxIds.add(info.sandboxId);
  return { ctx, runtimeId, dir, sandboxId: info?.sandboxId };
}

let offsetSeq = 0;
/** One chunk through fetchEntityChunk, with its provider-call breakdown. */
async function chunk(connector: any, entity: string) {
  const offset = (offsetSeq++ % 900) * 1000;
  trace = [];
  let rows = 0;
  let retries = 0;
  const t0 = performance.now();
  await connector.fetchEntityChunk({
    entity,
    maxIterations: 10,
    state: offset > 0 ? { totalProcessed: offset, hasMore: true, metadata: { type: "STREAM", stream: { stream_descriptor: { name: entity }, stream_state: { offset } } } } : undefined,
    onBatch: async (records: unknown[]) => {
      rows += records.length;
    },
    onLog: (level: string, message: string) => {
      if (level === "warn" && /over the protocol cap/.test(message)) retries++;
    },
  });
  const ms = performance.now() - t0;
  const calls = trace;
  trace = null;
  return { ms, rows, retries, calls };
}

function summarize(runs: Array<Awaited<ReturnType<typeof chunk>>>) {
  const breakdown: Record<string, number[]> = {};
  for (const r of runs) for (const c of r.calls) (breakdown[c.op] ??= []).push(c.ms);
  const rows = runs.reduce((a, r) => a + r.rows, 0);
  const total = runs.reduce((a, r) => a + r.ms, 0) / 1000;
  return {
    chunkMs: stats(runs.map(r => r.ms)),
    rowsPerChunk: stats(runs.map(r => r.rows)),
    rowsPerSecond: Math.round(rows / total),
    overCapRetries: runs.reduce((a, r) => a + r.retries, 0),
    calls: Object.fromEntries(
      Object.entries(breakdown).map(([k, v]) => [k, { perChunk: r1(v.length / Math.max(1, runs.length)), p50: r1(pct(v, 50)), p95: r1(pct(v, 95)) }]),
    ),
  };
}

const ENTITIES = ["fixed-1k", "call", "email"];

// ---------------------------------------------------------------------------
// Flag off
// ---------------------------------------------------------------------------
let warmOff: Prepared | null = null;
async function offWarmBox() {
  warmOff ??= await prepareSyncBox(`${RUN_ID}-warm`);
  return warmOff;
}

async function phaseOffWarm() {
  delete process.env.CONNECTOR_BOX_LEASES;
  const W = await offWarmBox();
  const c = makeConnector({ workspaceId: `${RUN_ID}-warm`, connectionId: "off-warm", prepared: W });
  await chunk(c, "fixed-1k"); // first run prepares the box's run directories
  const out: Record<string, unknown> = {};
  for (const entity of ENTITIES) {
    log(`off-warm: ${CHUNKS} chunks of ${entity}`);
    const runs = [];
    for (let i = 0; i < CHUNKS; i++) runs.push(await chunk(c, entity));
    out[entity] = summarize(runs);
    log(entity, JSON.stringify(out[entity]).slice(0, 400));
  }
  // The same no-op as bench G1, on the held handle the provider now keeps.
  const noop: number[] = [];
  for (let i = 0; i < 30; i++) {
    const t0 = performance.now();
    await provider.exec(W.ctx, "true", { timeoutMs: 30_000 });
    noop.push(performance.now() - t0);
  }
  out.providerExecNoopMs = stats(noop);
  results.offWarm = out;
}

/** Inside the box: what a chunk's process costs, apart from transport. */
async function phaseBoot() {
  const W = await offWarmBox();
  const box = await Sandbox.connect(W.sandboxId as string, { apiKey });
  const root = path.posix.dirname(path.posix.dirname(W.dir));
  const node = syncBox.connectorRuntimeNodePath(W.ctx, W.runtimeId);
  const bin = path.posix.join(root, "node_modules/@makoai/connector-sdk/bin/mako-connector.js");
  const conn = path.posix.join(W.dir, "connector.ts");
  const out: Record<string, unknown> = {};
  const series: Record<string, number[]> = {};
  const script = (entity: string) => `set -e
mkdir -p /tmp/g1b && echo '{}' > /tmp/g1b/c.json && echo '{"streams":[{"stream":{"name":"${entity}"}}]}' > /tmp/g1b/k.json
ms() { date +%s%N; }
a=$(ms); ${node} -e 0; b=$(ms)
${node} ${bin} spec --connector ${conn} > /dev/null; c=$(ms)
${node} ${bin} read --connector ${conn} --config /tmp/g1b/c.json --catalog /tmp/g1b/k.json --max-iterations 10 --max-bytes ${sandboxed.CHUNK_BYTE_BUDGET} > /tmp/g1b/o.jsonl; d=$(ms)
u=$(id -u); useradd -M -N -l -u 1999999 g1bench 2>/dev/null || true; userdel g1bench 2>/dev/null || true; e=$(ms)
echo $(( (b-a)/1000 )) $(( (c-b)/1000 )) $(( (d-c)/1000 )) $(( (e-d)/1000 )) $(wc -c < /tmp/g1b/o.jsonl)`;
  for (const entity of ["call", "email"]) {
    for (let i = 0; i < N; i++) {
      const r = await box.commands.run(script(entity), { user: "root", timeoutMs: 120_000 });
      const [nodeStart, spec, read, userAddDel, bytes] = r.stdout.trim().split(/\s+/).map(Number);
      (series[`${entity}:nodeStartMs`] ??= []).push(nodeStart / 1000);
      (series[`${entity}:specMs`] ??= []).push(spec / 1000);
      (series[`${entity}:readMs`] ??= []).push(read / 1000);
      (series[`${entity}:useraddUserdelMs`] ??= []).push(userAddDel / 1000);
      (series[`${entity}:bytes`] ??= []).push(bytes);
    }
  }
  for (const [k, v] of Object.entries(series)) out[k] = stats(v);
  await box.commands.run("rm -rf /tmp/g1b", { user: "root" });
  results.boot = out;
  log("boot", JSON.stringify(out).slice(0, 600));
}

async function phaseOffCold() {
  delete process.env.CONNECTOR_BOX_LEASES;
  const out: Record<string, unknown> = {};
  // New sync box: create, runtime install (Node download), folder, first chunk.
  const fresh: Array<Record<string, number>> = [];
  for (let i = 0; i < Math.min(N, 3); i++) {
    const ws = `${RUN_ID}-cold${i}`;
    trace = [];
    const t0 = performance.now();
    const P = await prepareSyncBox(ws);
    const prepMs = performance.now() - t0;
    const prepCalls = trace;
    const c = makeConnector({ workspaceId: ws, connectionId: `off-cold-${i}`, prepared: P });
    const r = await chunk(c, "call");
    fresh.push({ prepareMs: Math.round(prepMs), firstChunkMs: Math.round(r.ms), totalMs: Math.round(prepMs + r.ms), prepareCalls: prepCalls.length });
    await killSession(P.ctx.sessionKey);
  }
  out.newBoxFirstChunk = fresh;
  // Resume: pause the warm box, then a chunk (the held handle reconnects).
  const W = await offWarmBox();
  const c = makeConnector({ workspaceId: `${RUN_ID}-warm`, connectionId: "off-warm", prepared: W });
  const resumed = [];
  for (let i = 0; i < N; i++) {
    await provider.boxLifecycle.pause(W.ctx.sessionKey);
    resumed.push(await chunk(c, "call"));
  }
  out.afterPause = summarize(resumed);
  results.offCold = out;
  log("off-cold", JSON.stringify(out).slice(0, 600));
}

// ---------------------------------------------------------------------------
// Flag on
// ---------------------------------------------------------------------------
const scheduler = () => schedulerMod.getBoxScheduler();

async function killLeaseBoxes() {
  for (const box of memStore.boxes.values()) {
    if (box.state !== "killed") {
      await killSession(`connector-box:${box.boxId}`);
      box.state = "killed";
    }
  }
}

async function phaseOnWarm() {
  process.env.CONNECTOR_BOX_LEASES = "true";
  const c = makeConnector({ workspaceId: RUN_ID, connectionId: `${RUN_ID}-warm` });
  const first = await chunk(c, "fixed-1k");
  const out: Record<string, unknown> = { firstChunkFreshConnection: { ms: Math.round(first.ms), calls: first.calls.map(x => `${x.op} ${Math.round(x.ms)}`) } };
  for (const entity of ENTITIES) {
    log(`on-warm: ${CHUNKS} chunks of ${entity}`);
    const runs = [];
    for (let i = 0; i < CHUNKS; i++) runs.push(await chunk(c, entity));
    out[entity] = summarize(runs);
    log(entity, JSON.stringify(out[entity]).slice(0, 400));
  }
  results.onWarm = out;
}

async function phaseOnCold() {
  process.env.CONNECTOR_BOX_LEASES = "true";
  const out: Record<string, unknown> = {};
  // A new connection: fresh box, runtime, folder, snapshot, then the chunk.
  const fresh = [];
  for (let i = 0; i < Math.min(N, 3); i++) {
    const c = makeConnector({ workspaceId: RUN_ID, connectionId: `${RUN_ID}-new${i}` });
    fresh.push(await chunk(c, "call"));
    await killLeaseBoxes();
  }
  out.newConnection = summarize(fresh);
  // One connection with a template: resume after pause, restore after kill.
  const conn = `${RUN_ID}-tmpl`;
  const c = makeConnector({ workspaceId: RUN_ID, connectionId: conn });
  await chunk(c, "call"); // creates the box and its snapshot template
  const resumed = [];
  const restored = [];
  for (let i = 0; i < N; i++) {
    const idle = [...memStore.boxes.values()].find((b: any) => b.connectionId === conn && b.state === "idle");
    if (idle) await scheduler().pauseIfIdle(idle);
    resumed.push(await chunk(c, "call"));
  }
  for (let i = 0; i < N; i++) {
    const idle = [...memStore.boxes.values()].find((b: any) => b.connectionId === conn && b.state === "idle");
    if (idle) {
      await killSession(`connector-box:${idle.boxId}`);
      await memStore.transition(idle.boxId, { state: "idle", leasedBy: null }, { state: "killed", killedAt: new Date(), killReason: "bench" });
    }
    restored.push(await chunk(c, "call"));
  }
  out.afterPause = summarize(resumed);
  out.restoreFromTemplate = summarize(restored);
  out.templates = [...memStore.templates.values()].length;
  results.onCold = out;
  await killLeaseBoxes();
  log("on-cold", JSON.stringify(out).slice(0, 800));
}

async function parallelRun(k: number, entity: string, make: (i: number) => any) {
  const connectors = Array.from({ length: k }, (_, i) => make(i));
  // One chunk each first, so every box exists: cold starts are measured elsewhere.
  await Promise.all(connectors.map(c => chunk(c, entity)));
  const t0 = performance.now();
  const runs: Array<Awaited<ReturnType<typeof chunk>>> = [];
  await Promise.all(
    connectors.map(async c => {
      for (let i = 0; i < CHUNKS; i++) runs.push(await chunk(c, entity));
    }),
  );
  const wall = (performance.now() - t0) / 1000;
  const rows = runs.reduce((a, r) => a + r.rows, 0);
  return { k, wallS: r1(wall), rows, rowsPerSecond: Math.round(rows / wall), chunkMs: stats(runs.map(r => r.ms)) };
}

async function phaseParallel() {
  const out: Record<string, unknown> = {};
  process.env.CONNECTOR_BOX_LEASES = "true";
  for (const entity of ["call", "email"]) {
    for (const k of [1, 2, 4, 8]) {
      log(`parallel on: ${k} connections, ${CHUNKS} chunks each of ${entity}`);
      out[`on:${entity}:${k}`] = await parallelRun(k, entity, i => makeConnector({ workspaceId: RUN_ID, connectionId: `${RUN_ID}-par${i}` }));
      log(JSON.stringify(out[`on:${entity}:${k}`]));
      results.parallel = out;
      save();
    }
  }
  await killLeaseBoxes();
  delete process.env.CONNECTOR_BOX_LEASES;
  const W = await offWarmBox();
  for (const k of [1, 2, 4]) {
    log(`parallel off: ${k} concurrent chunks in one sync box`);
    out[`off:call:${k}`] = await parallelRun(k, "call", i => makeConnector({ workspaceId: `${RUN_ID}-warm`, connectionId: `off-par${i}`, prepared: W }));
    log(JSON.stringify(out[`off:call:${k}`]));
  }
  results.parallel = out;
}

// ---------------------------------------------------------------------------
// Cleanup
// ---------------------------------------------------------------------------
async function killSession(sessionKey: string) {
  const p = Sandbox.list({ apiKey, query: { metadata: { makoAppsSessionKey: sessionKey }, state: ["running", "paused"] } as any, limit: 20 });
  while (p.hasNext) for (const b of await p.nextItems()) sandboxIds.add(b.sandboxId);
  await provider.destroySession(sessionKey).catch(() => undefined);
  const q = Sandbox.list({ apiKey, query: { metadata: { makoAppsSessionKey: sessionKey }, state: ["running", "paused"] } as any, limit: 20 });
  let left = 0;
  while (q.hasNext) left += (await q.nextItems()).length;
  if (left === 0) {
    // Everything listed under this key is gone.
    for (const id of sandboxIds) if (!killedIds.has(id)) {
      try {
        await Sandbox.getInfo(id, { apiKey });
      } catch {
        killedIds.add(id);
      }
    }
  }
}

async function sweep() {
  for (const box of memStore.boxes.values()) sessionKeys.add(`connector-box:${box.boxId}`);
  for (const key of sessionKeys) await killSession(key);
  for (const t of memStore.templates.values()) if (t.snapshotId) snapshotIds.add(t.snapshotId);
  for (const id of snapshotIds) await Sandbox.deleteSnapshot(id, { apiKey }).catch(() => undefined);
  // Verify: nothing under this run's keys, running or paused. E2B's list
  // lags a kill by a few seconds, so look again before calling it a leak.
  let left = 0;
  for (let attempt = 0; attempt < 6; attempt++) {
    left = 0;
    const p = Sandbox.list({ apiKey, query: { state: ["running", "paused"] } as any, limit: 100 });
    while (p.hasNext) {
      for (const b of await p.nextItems()) {
        const key = String((b.metadata as any)?.makoAppsSessionKey);
        if (!sessionKeys.has(key)) continue;
        left++;
        if (attempt >= 2) await Sandbox.kill(b.sandboxId, { apiKey }).catch(() => undefined);
      }
    }
    if (left === 0) break;
    await new Promise(r => setTimeout(r, 5_000));
  }
  let snapsLeft = 0;
  const s = Sandbox.listSnapshots({ apiKey });
  while (s.hasNext) for (const x of await s.nextItems()) if (snapshotIds.has(x.snapshotId)) snapsLeft++;
  results.cleanup = { sessionKeys: sessionKeys.size, sandboxesSeen: sandboxIds.size, killedConfirmed: killedIds.size, leftUnderRunKeys: left, snapshots: snapshotIds.size, snapshotsLeft: snapsLeft };
}

let finishing: Promise<void> | null = null;
const started = performance.now();
async function finish(code: number): Promise<never> {
  finishing ??= (async () => {
    await sweep();
    results.totalSeconds = Math.round((performance.now() - started) / 1000);
    save();
    log("cleanup", results.cleanup, `results in ${OUT}`);
  })();
  await finishing;
  process.exit(code);
}
for (const [signal, code] of [["SIGINT", 130], ["SIGTERM", 143]] as const) {
  process.once(signal, () => {
    log(`${signal}: cleaning up`);
    void finish(code);
  });
}

const PHASE_FNS: Record<string, () => Promise<void>> = {
  "off-warm": phaseOffWarm,
  boot: phaseBoot,
  "off-cold": phaseOffCold,
  "on-warm": phaseOnWarm,
  "on-cold": phaseOnCold,
  parallel: phaseParallel,
};

log(`G1v2 ${RUN_ID}: e2b ${E2B_VERSION}, template ${TEMPLATE}, cap ${CAP}, phases ${PHASES.join(",")}`);
{
  const running = await runningCount();
  log(`account: ${running} running boxes`);
  if (running + 2 > CAP) {
    console.error(`Refusing to run: ${running} boxes already running against a cap of ${CAP}.`);
    process.exit(3);
  }
}
try {
  for (const phase of PHASES) {
    const t0 = performance.now();
    try {
      await PHASE_FNS[phase]();
    } catch (error) {
      results[`${phase}Error`] = error instanceof Error ? `${error.message}\n${error.stack?.split("\n").slice(1, 5).join("\n")}` : String(error);
      log(`${phase} failed:`, results[`${phase}Error`]);
    }
    (results.phaseSeconds ??= {})[phase] = r1((performance.now() - t0) / 1000);
    save();
  }
} finally {
  await finish(0);
}

/**
 * Parity harness: the in-process PandaDoc connector and this folder, run
 * against the same recorded PandaDoc responses, compared entity by entity.
 *
 * Both connectors talk to a local HTTP server through `api_base_url`. In
 * replay mode the server answers only requests it has a cassette for, so a
 * folder that sends a request the in-process connector never sent fails
 * with a cassette miss, and the request logs are compared as well.
 *
 * For each entity and scenario it compares:
 * - row count, key set and row order;
 * - column set (the union of fields across rows);
 * - a SHA-256 checksum per row, over canonical JSON;
 * - each row's source timestamp, as each side resolves it;
 * - the chunk sequence: the read position and hasMore after every chunk;
 * - the requests each side sent, as a multiset: document details go out
 *   5 at a time on both sides, so their arrival order is not fixed.
 *
 * The folder side runs through the API's `SandboxedConnector` when the
 * caller passes `makeBoxed` (the API test), with only the box replaced by a
 * local process. Without it, the SDK runner is driven directly
 * (`parity.mjs`). This file has no dependency on the API.
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { buildDataset, emulate } from "./dataset.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SLUG = "pandadoc";
export const FOLDER = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(FOLDER, "../..");
export const SDK_DIR = path.join(REPO_ROOT, "packages/connector-sdk");
export const RUNNER = path.join(SDK_DIR, "bin/mako-connector.js");
export const CASSETTE_DIR = path.join(here, "cassettes");
export const CLOCK = path.join(here, "clock.mjs");

export const FIXTURE_NOW = "2026-11-16T12:00:00.000Z";
/** The incremental anchor of the `since` scenario. */
export const SINCE = "2026-09-01T00:00:00.000Z";

export const ENTITIES = ["documents", "templates", "contacts", "members"];

export const SCENARIOS = [
  // Ten rows a page, one page per chunk.
  { name: "chunked", maxIterations: 1, pageSize: 10 },
  // Two rows a page, one page per chunk: every list resumes from a page.
  { name: "small-pages", maxIterations: 1, pageSize: 2 },
  // The engine's defaults: 100 rows a page, 10 pages a chunk.
  { name: "default", maxIterations: 10 },
  // Ten rows a page, 10 pages a chunk: hydration ends a chunk at 2 pages.
  { name: "paged", maxIterations: 10, pageSize: 10 },
  // Incremental from SINCE.
  { name: "since", maxIterations: 10, pageSize: 10, since: SINCE },
  // Hydration off: the list projection only.
  {
    name: "no-details",
    maxIterations: 10,
    pageSize: 10,
    config: { fetch_document_details: false },
  },
];

/** Every request answered 429 once (Retry-After: 1) before it succeeds. */
export const RATE_LIMIT_SCENARIO = {
  name: "rate-limited",
  maxIterations: 10,
  pageSize: 10,
  rateLimited: true,
};
export const RATE_LIMIT_ENTITIES = ["documents", "members"];

/** Environment for a folder process: frozen clock, short timers. */
export function folderEnv() {
  const preload = `--import ${pathToFileURL(CLOCK).href}`;
  return {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" "),
    MAKO_FIXTURE_NOW: FIXTURE_NOW,
    MAKO_FIXTURE_FAST_TIMERS: "1",
  };
}

/** Freeze `Date.now` in this process. Returns the restore function. */
export function freezeClock() {
  const real = Date.now;
  const frozen = Date.parse(FIXTURE_NOW);
  Date.now = () => frozen;
  return () => {
    Date.now = real;
  };
}

/** The folder's lockfile installed (no dependency), the SDK linked in. */
export function ensureFolderInstalled() {
  if (!fs.existsSync(path.join(FOLDER, "node_modules"))) {
    const result = spawnSync(
      "npm",
      ["ci", "--no-audit", "--no-fund", "--ignore-scripts"],
      { cwd: FOLDER, stdio: "inherit", shell: process.platform === "win32" },
    );
    if (result.status !== 0) {
      throw new Error(`npm ci failed in ${FOLDER} (exit ${result.status})`);
    }
  }
  const sdkLink = path.join(FOLDER, "node_modules/@makoai/connector-sdk");
  if (!fs.existsSync(sdkLink)) {
    fs.mkdirSync(path.dirname(sdkLink), { recursive: true });
    fs.symlinkSync(
      path.relative(path.dirname(sdkLink), SDK_DIR),
      sdkLink,
      "dir",
    );
  }
}

// ---------------------------------------------------------------------------
// Requests and cassettes
// ---------------------------------------------------------------------------

/** JSON with keys sorted at every level; `undefined` dropped, as JSON does. */
export function canonicalJson(value) {
  if (Array.isArray(value))
    return `[${value.map(v => canonicalJson(v ?? null)).join(",")}]`;
  if (value && typeof value === "object") {
    const keys = Object.keys(value)
      .filter(key => value[key] !== undefined)
      .sort();
    return `{${keys.map(key => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

/** `GET /x?b=2&a=1` -> `GET /x?a=1&b=2`, decoded, so encodings agree. */
export function requestKey(method, rawUrl) {
  const url = new URL(rawUrl, "http://fixture.local");
  const pairs = [...url.searchParams.entries()].sort(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b),
  );
  const query = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  return `${method} ${decodeURIComponent(url.pathname)}${query ? `?${query}` : ""}`;
}

/** The key a request carries: `Authorization: API-Key <key>`. */
function apiKeyOf(req) {
  const header = String(req.headers.authorization ?? "");
  return header.startsWith("API-Key ") ? header.slice(8) : "";
}

/** Every cassette file, merged into one request -> response map. */
export function loadCassettes(dir = CASSETTE_DIR) {
  const interactions = new Map();
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    for (const entry of JSON.parse(
      fs.readFileSync(path.join(dir, file), "utf8"),
    )) {
      interactions.set(entry.request, {
        status: entry.status,
        body: entry.body,
      });
    }
  }
  return interactions;
}

/** One file per route, one interaction per line, so diffs stay readable. */
export function saveCassettes(recorded, dir = CASSETTE_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    fs.unlinkSync(path.join(dir, file));
  }
  const byFile = new Map();
  for (const [request, response] of [...recorded].sort(([a], [b]) =>
    a.localeCompare(b),
  )) {
    const route = request
      .split(" ")[1]
      .split("?")[0]
      .replace(/^\/public\/v1\//, "")
      .replace(/\/[^/]+\/details$/, "_details");
    if (!byFile.has(route)) byFile.set(route, []);
    byFile.get(route).push(JSON.stringify({ request, ...response }));
  }
  for (const [name, lines] of byFile) {
    fs.writeFileSync(
      path.join(dir, `${name.replace(/[^a-zA-Z0-9_]/g, "_")}.json`),
      `[\n${lines.join(",\n")}\n]\n`,
    );
  }
}

/**
 * A local PandaDoc. Every request is logged under the key that sent it,
 * which keeps concurrent runs apart. Only `api_test_` keys are served: this
 * server must never see a real key. `_revoked` gets 401. `_ratelimit` gets
 * one 429 with `Retry-After: 1` per distinct request first.
 */
async function startServer(answer) {
  const log = new Map();
  const limited = new Set();
  const server = http.createServer((req, res) => {
    req.resume();
    req.on("end", () => {
      const method = req.method ?? "GET";
      const key = requestKey(method, req.url ?? "/");
      const apiKey = apiKeyOf(req);
      if (!log.has(apiKey)) log.set(apiKey, []);
      log.get(apiKey).push(key);
      let response;
      let headers = {};
      if (!apiKey.startsWith("api_test_")) {
        response = { status: 401, body: { detail: "Authentication failed" } };
      } else if (apiKey.includes("_revoked")) {
        response = { status: 401, body: { detail: "API key is revoked" } };
      } else if (
        apiKey.includes("_ratelimit") &&
        !limited.has(`${apiKey} ${key}`)
      ) {
        limited.add(`${apiKey} ${key}`);
        response = { status: 429, body: { detail: "Too many requests" } };
        headers = { "retry-after": "1" };
      } else {
        response = answer(key, method, req.url ?? "/");
      }
      res.writeHead(response.status, {
        "content-type": "application/json",
        ...headers,
      });
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests: apiKey => [...(log.get(apiKey) ?? [])],
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/** Replay: answer from cassettes only. A miss is a 404 the connector sees. */
export async function startReplayServer(interactions = loadCassettes()) {
  const misses = [];
  const server = await startServer(key => {
    const hit = interactions.get(key);
    if (hit) return hit;
    misses.push(key);
    return { status: 404, body: { detail: `No cassette for ${key}` } };
  });
  return { ...server, misses };
}

/** Record: answer from the emulator over `dataset`, keep every interaction. */
export async function startRecordingServer(dataset = buildDataset()) {
  const recorded = new Map();
  const server = await startServer((key, method, url) => {
    const response = emulate(dataset, method, url);
    recorded.set(key, response);
    return response;
  });
  return { ...server, recorded, dataset };
}

// ---------------------------------------------------------------------------
// Running the two connectors
// ---------------------------------------------------------------------------

const scratch = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), `mako-${SLUG}-parity-`));

/** Run one SDK command on the folder and parse its JSON Lines. */
export function runFolderCommand(
  command,
  { config, catalog, state, batch, maxIterations, maxBytes } = {},
) {
  const dir = scratch();
  const args = [
    RUNNER,
    command,
    "--connector",
    path.join(FOLDER, "connector.ts"),
  ];
  const file = (name, value) => {
    const target = path.join(dir, name);
    fs.writeFileSync(target, JSON.stringify(value));
    return target;
  };
  if (config) args.push("--config", file("config.json", config));
  if (catalog) args.push("--catalog", file("catalog.json", catalog));
  if (state) args.push("--state", file("state.json", state));
  if (batch) args.push("--batch", file("batch.json", batch));
  if (maxIterations) args.push("--max-iterations", String(maxIterations));
  if (maxBytes) args.push("--max-bytes", String(maxBytes));

  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: FOLDER,
      env: folderEnv(),
      stdio: ["ignore", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("close", code => {
      fs.rmSync(dir, { recursive: true, force: true });
      const lines = stdout.split("\n").filter(line => line.trim());
      resolve({ code, messages: lines.map(line => JSON.parse(line)), stderr });
    });
  });
}

function folderFailure(result) {
  const trace = result.messages.find(
    m => m.type === "TRACE" && m.trace?.type === "ERROR",
  );
  if (trace) return trace.trace.error.message;
  if (result.code !== 0) return result.stderr.trim() || `exit ${result.code}`;
  return null;
}

/** A read position without Mako's anchor. */
export function positionOf(state) {
  if (!state) return {};
  const { mako: _mako, ...position } = state;
  return position;
}

/** The in-process `FetchState` as a read position. */
export function inProcessPosition(state) {
  if (!state) return {};
  return {
    ...(state.page !== undefined ? { page: state.page } : {}),
    totalProcessed: state.totalProcessed,
    ...(state.metadata ?? {}),
  };
}

/** Drive the folder chunk by chunk, as `SandboxedConnector` does. */
export async function readFolder({ entity, config, since, maxIterations }) {
  const rows = [];
  const chunks = [];
  let state = since
    ? [
        {
          type: "STREAM",
          stream: {
            stream_descriptor: { name: entity },
            stream_state: { mako: { since } },
          },
        },
      ]
    : undefined;
  for (let chunk = 0; chunk < 500; chunk++) {
    const result = await runFolderCommand("read", {
      config,
      catalog: {
        streams: [{ stream: { name: entity }, sync_mode: "incremental" }],
      },
      state,
      maxIterations,
    });
    const failure = folderFailure(result);
    if (failure) throw new Error(`folder read of ${entity} failed: ${failure}`);
    for (const message of result.messages) {
      if (message.type === "RECORD" && message.record.stream === entity) {
        rows.push(message.record.data);
      }
    }
    const stateMessage = result.messages
      .filter(m => m.type === "STATE")
      .at(-1)?.state;
    const hasMore = stateMessage?.mako?.hasMore === true;
    chunks.push({
      position: positionOf(stateMessage?.stream?.stream_state),
      hasMore,
    });
    if (!hasMore) break;
    state = [stateMessage];
  }
  return { rows, chunks };
}

/** Drive `SandboxedConnector` (the box path) chunk by chunk, as the engine does. */
export async function readBoxed(
  connector,
  { entity, since, maxIterations, pageSize },
) {
  const rows = [];
  const chunks = [];
  let state;
  for (let chunk = 0; chunk < 500; chunk++) {
    state = await connector.fetchEntityChunk({
      entity,
      since: since ? new Date(since) : undefined,
      maxIterations,
      ...(pageSize ? { batchSize: pageSize } : {}),
      rateLimitDelay: 1,
      state,
      onBatch: async batch => {
        rows.push(...batch);
      },
    });
    chunks.push({
      position: positionOf(state.metadata?.stream?.stream_state),
      hasMore: state.hasMore,
    });
    if (!state.hasMore) break;
  }
  return { rows, chunks };
}

/** Drive the in-process connector chunk by chunk, a fresh one per chunk. */
export async function readInProcess(
  makeConnector,
  { entity, since, maxIterations, pageSize },
) {
  const rows = [];
  const chunks = [];
  let state;
  for (let chunk = 0; chunk < 500; chunk++) {
    state = await makeConnector().fetchEntityChunk({
      entity,
      since: since ? new Date(since) : undefined,
      maxIterations,
      ...(pageSize ? { batchSize: pageSize } : {}),
      rateLimitDelay: 1,
      state,
      onBatch: async batch => {
        rows.push(...batch);
      },
    });
    chunks.push({ position: inProcessPosition(state), hasMore: state.hasMore });
    if (!state.hasMore) break;
  }
  return { rows, chunks };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/** Checksum of a row as it lands, through JSON on both sides. */
export const rowChecksum = row =>
  crypto
    .createHash("sha256")
    .update(canonicalJson(JSON.parse(JSON.stringify(row))))
    .digest("hex");

const columnsOf = rows =>
  [...new Set(rows.flatMap(row => Object.keys(row)))].sort();
const sameList = (a, b) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** Every comparison for one entity and scenario. `ok` is the conjunction. */
export function compareRuns(inProcess, folder, sourceTs, entity) {
  const inIds = inProcess.rows.map(row => String(row.id));
  const folderIds = folder.rows.map(row => String(row.id));
  const checksumMismatches = [];
  const timestampMismatches = [];
  const n = Math.min(inProcess.rows.length, folder.rows.length);
  for (let i = 0; i < n; i++) {
    const a = inProcess.rows[i];
    const b = folder.rows[i];
    if (rowChecksum(a) !== rowChecksum(b)) checksumMismatches.push(inIds[i]);
    if (
      sourceTs &&
      canonicalJson(sourceTs.inProcess(a, entity)) !==
        canonicalJson(sourceTs.folder(b, entity))
    ) {
      timestampMismatches.push(inIds[i]);
    }
  }
  const inRequests = [...(inProcess.requests ?? [])].sort();
  const folderRequests = [...(folder.requests ?? [])].sort();
  const result = {
    rows: [inProcess.rows.length, folder.rows.length],
    keys: sameList([...new Set(inIds)].sort(), [...new Set(folderIds)].sort()),
    order: sameList(inIds, folderIds),
    columns: sameList(columnsOf(inProcess.rows), columnsOf(folder.rows)),
    columnCount: columnsOf(inProcess.rows).length,
    checksumMismatches,
    timestampMismatches,
    chunks: [inProcess.chunks.length, folder.chunks.length],
    chunkStates:
      canonicalJson(inProcess.chunks) === canonicalJson(folder.chunks),
    requests: [inRequests.length, folderRequests.length],
    requestsEqual: sameList(inRequests, folderRequests),
  };
  result.ok =
    result.rows[0] === result.rows[1] &&
    result.keys &&
    result.order &&
    result.columns &&
    checksumMismatches.length === 0 &&
    timestampMismatches.length === 0 &&
    result.chunkStates &&
    result.requestsEqual;
  return result;
}

/**
 * Run every entity in every scenario against one server.
 * `makeInProcess(config)` returns a fresh in-process connector.
 */
export async function runParity({
  entities = ENTITIES,
  makeInProcess,
  makeBoxed,
  server,
  sourceTs,
  scenarios = SCENARIOS,
  concurrency = 6,
}) {
  const jobs = [];
  for (const scenario of scenarios) {
    for (const entity of entities) jobs.push({ entity, scenario });
  }
  const results = [];
  const work = async ({ entity, scenario }) => {
    const options = {
      entity,
      since: scenario.since,
      maxIterations: scenario.maxIterations,
      pageSize: scenario.pageSize,
    };
    const limited = scenario.rateLimited ? "_ratelimit" : "";
    const inKey = `api_test_inprocess${limited}_${scenario.name}_${entity}`;
    const folderKey = `api_test_folder${limited}_${scenario.name}_${entity}`;
    const extra = scenario.config ?? {};
    const run = async (side, read) => {
      try {
        return await read();
      } catch (error) {
        return {
          rows: [],
          chunks: [],
          error: `${side}: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
    };
    const inProcess = await run("in-process", () =>
      readInProcess(
        () =>
          makeInProcess({ api_key: inKey, api_base_url: server.url, ...extra }),
        options,
      ),
    );
    inProcess.requests = server.requests(inKey);
    const config = { api_key: folderKey, api_base_url: server.url, ...extra };
    const boxed = makeBoxed?.(config);
    const folder = await run("folder", () =>
      boxed
        ? readBoxed(boxed, options)
        : readFolder({
            ...options,
            config: {
              ...config,
              ...(scenario.pageSize ? { __page_size: scenario.pageSize } : {}),
            },
          }),
    );
    folder.requests = server.requests(folderKey);
    const comparison = compareRuns(inProcess, folder, sourceTs, entity);
    const error = inProcess.error ?? folder.error;
    results.push({
      entity,
      scenario: scenario.name,
      ...comparison,
      error,
      ok: comparison.ok && !error,
    });
  };
  const queue = [...jobs];
  await Promise.all(
    Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
      while (queue.length > 0) await work(queue.shift());
    }),
  );
  const order = new Map(
    jobs.map((job, i) => [`${job.scenario.name}/${job.entity}`, i]),
  );
  return results.sort(
    (a, b) =>
      order.get(`${a.scenario}/${a.entity}`) -
      order.get(`${b.scenario}/${b.entity}`),
  );
}

/** `check` on both sides, with a working key and a revoked one. */
export async function checkParity({ makeInProcess, server }) {
  const outcomes = [];
  for (const variant of ["valid", "revoked"]) {
    const suffix = variant === "revoked" ? "_revoked" : "";
    const inKey = `api_test_inprocess_check${suffix}`;
    const folderKey = `api_test_folder_check${suffix}`;
    const inResult = await makeInProcess({
      api_key: inKey,
      api_base_url: server.url,
    }).testConnection();
    const folderRun = await runFolderCommand("check", {
      config: { api_key: folderKey, api_base_url: server.url },
    });
    const status = folderRun.messages.find(
      m => m.type === "CONNECTION_STATUS",
    )?.connectionStatus;
    outcomes.push({
      variant,
      inProcess: inResult.success,
      folder: status?.status === "SUCCEEDED",
      folderMessage: status?.message,
      requestsEqual: sameList(
        server.requests(inKey),
        server.requests(folderKey),
      ),
    });
  }
  return outcomes;
}

/** A plain-text table, one row per entity, one column group per scenario. */
export function formatReport(results) {
  const scenarios = [...new Set(results.map(r => r.scenario))];
  const entities = [...new Set(results.map(r => r.entity))];
  const lines = [
    [
      "entity",
      ...scenarios.map(s => `${s}: rows in/folder, chunks, requests, result`),
    ].join(" | "),
  ];
  for (const entity of entities) {
    const cells = [entity];
    for (const scenario of scenarios) {
      const r = results.find(
        x => x.entity === entity && x.scenario === scenario,
      );
      if (!r) {
        cells.push("-");
        continue;
      }
      const problems = [];
      if (!r.keys) problems.push("keys");
      if (!r.order) problems.push("order");
      if (!r.columns) problems.push("columns");
      if (r.checksumMismatches.length)
        problems.push(`${r.checksumMismatches.length} checksums`);
      if (r.timestampMismatches.length)
        problems.push(`${r.timestampMismatches.length} source timestamps`);
      if (!r.chunkStates) problems.push("chunk states");
      if (!r.requestsEqual) problems.push("requests");
      if (r.error) problems.push(`error (${r.error})`);
      cells.push(
        `${r.rows[0]}/${r.rows[1]}, ${r.chunks[0]}/${r.chunks[1]}, ${r.requests[0]}/${r.requests[1]}, ${r.ok ? "match" : `DIFF ${problems.join(", ")}`}`,
      );
    }
    lines.push(cells.join(" | "));
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Schemas and the credential form
// ---------------------------------------------------------------------------

/**
 * The in-process `ConnectorEntitySchema` against the folder's stream as the
 * engine translates it. Fields in `ignore` (Mako's system columns) are left
 * out of the field lists and compared in full on their own.
 */
export function compareEntitySchema(inProcess, folder, ignore = new Set()) {
  const names = schema =>
    Object.keys(schema?.fields ?? {})
      .filter(name => !ignore.has(name))
      .sort();
  const inNames = names(inProcess);
  const folderNames = names(folder);
  const nullable = field => field.nullable ?? !field.required;
  const fieldDiffs = [];
  for (const name of inNames) {
    const a = inProcess.fields[name];
    const b = folder?.fields?.[name];
    if (!b) continue;
    if (a.type !== b.type)
      fieldDiffs.push(`${name}: type ${a.type} vs ${b.type}`);
    if (nullable(a) !== nullable(b))
      fieldDiffs.push(`${name}: nullable ${nullable(a)} vs ${nullable(b)}`);
    if (Boolean(a.required) !== Boolean(b.required))
      fieldDiffs.push(
        `${name}: required ${Boolean(a.required)} vs ${Boolean(b.required)}`,
      );
  }
  const missing = inNames.filter(name => !folderNames.includes(name));
  const extra = folderNames.filter(name => !inNames.includes(name));
  const keyColumns =
    canonicalJson(inProcess?.keyColumns) === canonicalJson(folder?.keyColumns);
  const policy = inProcess?.unknownFieldPolicy === folder?.unknownFieldPolicy;
  const systemDiffs = [...ignore]
    .filter(
      name =>
        canonicalJson(inProcess?.fields?.[name] ?? null) !==
        canonicalJson(folder?.fields?.[name] ?? null),
    )
    .sort();
  return {
    fields: [inNames.length, folderNames.length],
    missing,
    extra,
    fieldDiffs,
    keyColumns,
    policy,
    systemDiffs,
    ok:
      missing.length === 0 &&
      extra.length === 0 &&
      fieldDiffs.length === 0 &&
      keyColumns &&
      policy,
  };
}

/** `getConfigSchema().fields` against the form built from the folder's spec. */
export function compareForm(inProcessFields, folderFields) {
  const shape = field => ({
    name: field.name,
    label: field.label,
    type: field.type,
    required: Boolean(field.required),
    default: field.default,
    helperText: field.helperText,
    placeholder: field.placeholder,
  });
  const a = inProcessFields.map(shape);
  const b = folderFields.map(shape);
  return { ok: canonicalJson(a) === canonicalJson(b), inProcess: a, folder: b };
}

/**
 * A factory of in-process connectors. Waits are stubbed; the requests are
 * not.
 */
export function inProcessFactory(Connector, type = SLUG) {
  return config => {
    const connector = new Connector({
      id: "ds_parity",
      name: "Parity",
      type,
      config,
    });
    connector.sleep = async () => {};
    return connector;
  };
}

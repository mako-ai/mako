/**
 * Parity harness: the in-process GraphQL connector and this folder, run
 * against the same recorded GraphQL responses, compared query by query.
 *
 * Both connectors POST to a local server through `endpoint`. In replay mode
 * the server answers only requests it has a cassette for, so a folder that
 * sends a different request than the in-process connector fails with a
 * cassette miss, and the request logs are compared as well.
 *
 * For each query and scenario it compares:
 * - row count, key set and row order;
 * - column set (the union of fields across rows);
 * - a SHA-256 checksum per row, over canonical JSON;
 * - the chunk sequence: offset, cursor, rows processed, total count and
 *   hasMore after every chunk;
 * - the exact request sequence each connector sent (body and the header
 *   that carried the credential), retries included;
 * - each row's source timestamp, as each connector resolves it.
 *
 * The in-process connector is SSRF-guarded and refuses a loopback endpoint.
 * The harness lifts only that guard (`liftSsrfGuard`) so it can reach the
 * local server; headers, body and retries are the production code's.
 *
 * The folder side runs through the API's `SandboxedConnector` when the
 * caller passes `makeBoxed` (the API test), else through the SDK runner
 * directly (`parity.mjs`). This file has no dependency on the API.
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import https from "node:https";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { FLOW_QUERIES, QUERIES } from "./dataset.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const FOLDER = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(FOLDER, "../..");
export const SDK_DIR = path.join(REPO_ROOT, "packages/connector-sdk");
export const RUNNER = path.join(SDK_DIR, "bin/mako-connector.js");
export const CASSETTE_DIR = path.join(here, "cassettes");
export { FLOW_QUERIES };

/** The incremental anchor of the `since` scenarios. */
export const SINCE = "2026-01-01T00:00:00.000Z";
export const CONNECTION_ID = "ds_parity";
export const WORKSPACE_ID = "ws_parity";

export const SCENARIOS = [
  // One request per chunk: every cursor and offset crosses a boundary.
  { name: "chunked", maxIterations: 1 },
  // Two rows a page (a probe's batch size), one page per chunk. It wins
  // over every query's own `batch_size`, as `options.batchSize` does.
  { name: "small-pages", maxIterations: 1, pageSize: 2 },
  // The engine's default chunk of 10 requests.
  { name: "default", maxIterations: 10 },
  // Incremental: the client filter on updated_at, and `$since` sent.
  { name: "since", maxIterations: 10, since: SINCE },
  // Hasura's admin-secret header instead of a bearer token.
  { name: "hasura-secret", maxIterations: 10, headerStyle: "hasura" },
];

/** A 429, then a 503, on each query's first page, before the real answer. */
export const RATE_LIMIT_SCENARIO = {
  name: "rate-limited",
  maxIterations: 10,
  rateLimited: true,
};

export function ensureFolderInstalled() {
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

/** `POST /graphql {"query":...,"variables":...}`, the body canonical. */
export function requestKey(method, rawUrl, body = "") {
  const url = new URL(rawUrl, "http://graphql.local");
  let suffix = "";
  if (body) {
    try {
      suffix = ` ${canonicalJson(JSON.parse(body))}`;
    } catch {
      suffix = ` ${body}`;
    }
  }
  return `${method} ${url.pathname}${url.search}${suffix}`;
}

/** The token a request carries, and which header carried it. */
function credential(req) {
  const header = String(req.headers.authorization ?? "");
  if (header.startsWith("Bearer "))
    return { token: header.slice(7), style: "bearer" };
  const secret = req.headers["x-hasura-admin-secret"];
  if (secret) return { token: String(secret), style: "hasura" };
  return { token: "", style: "none" };
}

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

export function saveCassettes(byFile, dir = CASSETTE_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    fs.unlinkSync(path.join(dir, file));
  }
  for (const [name, interactions] of byFile) {
    const lines = [...interactions].map(([request, response]) =>
      JSON.stringify({ request, status: response.status, body: response.body }),
    );
    fs.writeFileSync(
      path.join(dir, `${name}.json`),
      `[\n${lines.join(",\n")}\n]\n`,
    );
  }
}

const graphqlError = (status, message) => ({
  status,
  body: { errors: [{ message }] },
});

/**
 * A local GraphQL endpoint at `/graphql`. Every request is logged under the
 * token that sent it, with the header that carried it. Only `gql_test_`
 * tokens are served. A token with `_revoked` gets 401. A token with
 * `_ratelimit` gets a 429 (`Retry-After: 0`) and then a 503 on its first
 * distinct request, so both retry branches run on both sides.
 */
async function startServer(answer) {
  const log = new Map();
  const limited = new Map();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      const key = requestKey(req.method ?? "POST", req.url ?? "/", body);
      const { token, style } = credential(req);
      if (!log.has(token)) log.set(token, []);
      log.get(token).push({ key, style });

      let response;
      let headers = {};
      if (!token.startsWith("gql_test_")) {
        response = graphqlError(
          401,
          "Only gql_test_ tokens are served by the fixture server.",
        );
      } else if (token.includes("_revoked")) {
        response = graphqlError(401, "invalid token");
      } else if (
        token.includes("_ratelimit") &&
        (limited.get(token) ?? 0) < 2
      ) {
        const seen = limited.get(token) ?? 0;
        limited.set(token, seen + 1);
        response =
          seen === 0
            ? graphqlError(429, "rate limit exceeded")
            : graphqlError(503, "upstream unavailable");
        if (seen === 0) headers = { "retry-after": "0" };
      } else if (token.includes("_errors")) {
        response = {
          status: 200,
          body: {
            errors: [{ message: "field 'x' not found in type: 'query_root'" }],
          },
        };
      } else {
        response = answer(key, body);
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
    requests: token =>
      (log.get(token) ?? []).map(({ key, style }) => `${key} (${style})`),
    requestKeys: token => (log.get(token) ?? []).map(({ key }) => key),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

export async function startReplayServer(interactions = loadCassettes()) {
  const misses = [];
  const server = await startServer(key => {
    const hit = interactions.get(key);
    if (hit) return hit;
    misses.push(key);
    return graphqlError(404, `No cassette for ${key}`);
  });
  return { ...server, misses };
}

/** Record: answer from the dataset's resolvers, and keep every interaction. */
export async function startRecordingServer() {
  const recorded = new Map();
  const server = await startServer((key, body) => {
    const response = emulate(body);
    recorded.set(key, response);
    return response;
  });
  return { ...server, recorded };
}

function emulate(body) {
  const { query, variables } = JSON.parse(body || "{}");
  if (query?.includes("__schema")) {
    return {
      status: 200,
      body: { data: { __schema: { queryType: { name: "query_root" } } } },
    };
  }
  const known = QUERIES.find(q => q.query === query);
  if (!known) return graphqlError(400, "unknown query");
  return { status: 200, body: known.resolve(variables ?? {}) };
}

// ---------------------------------------------------------------------------
// Running the two connectors
// ---------------------------------------------------------------------------

const scratch = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "mako-graphql-parity-"));

/** A connection config for `token` against `server`, with the flow's queries. */
export function testConfig(token, server, scenario = {}) {
  const headers =
    scenario.headerStyle === "hasura"
      ? { "x-hasura-admin-secret": token }
      : { Authorization: `Bearer ${token}` };
  return {
    endpoint: `${server.url}/graphql`,
    headers: JSON.stringify(headers),
    queries: FLOW_QUERIES,
  };
}

/**
 * The in-process client with only its SSRF guard lifted: no request
 * interceptor (the address check), plain agents (the guarded lookup).
 * Headers, base URL and everything else stay as `getGraphQLClient` built.
 */
export function liftSsrfGuard(connector) {
  let client;
  try {
    client = connector.getGraphQLClient();
  } catch {
    // A config the client refuses (headers that are not JSON): there is
    // nothing to lift, and `testConnection` reports it.
    return connector;
  }
  client.interceptors.request.clear();
  client.defaults.httpAgent = new http.Agent();
  client.defaults.httpsAgent = new https.Agent();
  return connector;
}

export function runFolderCommand(
  command,
  { config, catalog, state, maxIterations, maxBytes, env } = {},
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
  if (maxIterations) args.push("--max-iterations", String(maxIterations));
  if (maxBytes) args.push("--max-bytes", String(maxBytes));
  return new Promise((resolve, reject) => {
    const child = spawn(process.execPath, args, {
      cwd: FOLDER,
      stdio: ["ignore", "pipe", "pipe"],
      env: { ...process.env, ...(env ?? {}) },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("close", code => {
      fs.rmSync(dir, { recursive: true, force: true });
      const messages = stdout
        .split("\n")
        .filter(line => line.trim())
        .map(line => JSON.parse(line));
      resolve({ code, messages, stderr });
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

/** The resume position, the same shape from either side's state. */
export function streamPosition(source, hasMore) {
  const count = source?.totalCount;
  return {
    offset: source?.offset ?? 0,
    cursor: source?.cursor ?? null,
    totalProcessed: source?.totalProcessed ?? 0,
    totalCount: count === undefined || count === null ? null : count,
    hasMore: Boolean(hasMore),
  };
}

/** In-process `FetchState`, or `SandboxedConnector`'s around the stream state. */
export function chunkPosition(state) {
  const stream = state?.metadata?.stream?.stream_state;
  if (stream) return streamPosition(stream, state.hasMore);
  return streamPosition(
    {
      offset: state?.offset,
      cursor: state?.cursor,
      totalProcessed: state?.totalProcessed,
      totalCount: state?.metadata?.totalCount,
    },
    state?.hasMore,
  );
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
  for (let chunk = 0; chunk < 1000; chunk++) {
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
      if (message.type === "RECORD" && message.record.stream === entity)
        rows.push(message.record.data);
    }
    const stateMessage = result.messages
      .filter(m => m.type === "STATE")
      .at(-1)?.state;
    const hasMore = stateMessage?.mako?.hasMore === true;
    chunks.push(streamPosition(stateMessage?.stream?.stream_state, hasMore));
    if (!hasMore) break;
    state = [stateMessage];
  }
  return { rows, chunks };
}

/**
 * Drive a connector as the engine does: its schema, then `fetchEntityChunk`
 * until `hasMore` is false, with a fresh connector per chunk (each chunk is
 * its own Inngest step) and the engine's `onProgress`.
 */
export async function readInProcess(
  makeConnector,
  { entity, since, maxIterations, pageSize },
) {
  const rows = [];
  const chunks = [];
  let state;
  await makeConnector().resolveSchema?.(entity);
  for (let chunk = 0; chunk < 1000; chunk++) {
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
      onProgress: () => {},
    });
    chunks.push(chunkPosition(state));
    if (!state.hasMore) break;
  }
  return { rows, chunks };
}

/** Each row's source timestamp, by id; within a minute of now is "now". */
export function sourceTimestamps(connector, entity, rows) {
  const now = Date.now();
  const byId = new Map();
  let fellBackToNow = 0;
  for (const row of rows) {
    const ts = connector.normalizeBackfillRecord?.(entity, row)?.sourceTs;
    const fellBack =
      !(ts instanceof Date) || Math.abs(ts.getTime() - now) < 60_000;
    if (fellBack) fellBackToNow++;
    byId.set(String(row.id), fellBack ? "now" : ts.toISOString());
  }
  return { byId, fellBackToNow };
}

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

export const rowChecksum = row =>
  crypto
    .createHash("sha256")
    .update(canonicalJson(JSON.parse(JSON.stringify(row))))
    .digest("hex");

const columnsOf = rows =>
  [...new Set(rows.flatMap(row => Object.keys(row)))].sort();
const sameList = (a, b) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

export function compareRuns(inProcess, folder) {
  const inIds = inProcess.rows.map(row => String(row.id));
  const folderIds = folder.rows.map(row => String(row.id));
  const inSums = inProcess.rows.map(rowChecksum);
  const folderSums = folder.rows.map(rowChecksum);
  // By position: ids repeat on purpose in nothing here, but order matters.
  const checksumMismatches = inSums
    .map((sum, i) => (folderSums[i] === sum ? null : inIds[i]))
    .filter(Boolean);
  const inColumns = columnsOf(inProcess.rows);
  const folderColumns = columnsOf(folder.rows);
  const result = {
    rows: [inProcess.rows.length, folder.rows.length],
    keys: sameList([...new Set(inIds)].sort(), [...new Set(folderIds)].sort()),
    order: sameList(inIds, folderIds),
    columns: sameList(inColumns, folderColumns),
    columnCount: inColumns.length,
    checksumMismatches,
    chunks: [inProcess.chunks.length, folder.chunks.length],
    chunkStates:
      canonicalJson(inProcess.chunks) === canonicalJson(folder.chunks),
    requests: [inProcess.requests?.length ?? 0, folder.requests?.length ?? 0],
    requestsEqual: sameList(inProcess.requests ?? [], folder.requests ?? []),
    timestampMismatches: [],
    timestampsChecked: 0,
  };
  if (inProcess.timestamps && folder.timestamps) {
    for (const [id, ts] of inProcess.timestamps.byId) {
      result.timestampsChecked++;
      if (folder.timestamps.byId.get(id) !== ts)
        result.timestampMismatches.push(id);
    }
  }
  result.ok =
    result.rows[0] === result.rows[1] &&
    result.keys &&
    result.order &&
    result.columns &&
    checksumMismatches.length === 0 &&
    result.chunkStates &&
    result.requestsEqual &&
    result.timestampMismatches.length === 0;
  return result;
}

const tokenFor = (side, scenario, entity) =>
  `gql_test_${side}_${scenario.name}_${entity}${scenario.rateLimited ? "_ratelimit" : ""}`;

export async function runParity({
  entities,
  makeInProcess,
  makeBoxed,
  server,
  scenarios = [...SCENARIOS, RATE_LIMIT_SCENARIO],
  concurrency = 4,
}) {
  const jobs = [];
  for (const scenario of scenarios)
    for (const entity of entities) jobs.push({ entity, scenario });
  const results = [];
  const work = async ({ entity, scenario }) => {
    const options = {
      entity,
      since: scenario.since,
      maxIterations: scenario.maxIterations,
      pageSize: scenario.pageSize,
    };
    const inKey = tokenFor("inprocess", scenario, entity);
    const folderKey = tokenFor("folder", scenario, entity);
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
    const inConfig = testConfig(inKey, server, scenario);
    const inProcess = await run("in-process", () =>
      readInProcess(() => makeInProcess(inConfig), options),
    );
    inProcess.requests = server.requests(inKey);
    let folder;
    if (makeBoxed) {
      const folderConfig = testConfig(folderKey, server, scenario);
      // One adapter for the whole read: a read session lives in it.
      const box = makeBoxed(folderConfig);
      folder = await run("folder", () => readInProcess(() => box, options));
      inProcess.timestamps = sourceTimestamps(
        makeInProcess(inConfig),
        entity,
        inProcess.rows,
      );
      folder.timestamps = sourceTimestamps(
        makeBoxed(folderConfig),
        entity,
        folder.rows,
      );
    } else {
      folder = await run("folder", () =>
        readFolder({
          ...options,
          config: {
            ...testConfig(folderKey, server, scenario),
            ...(scenario.pageSize
              ? {
                  __page_size: scenario.pageSize,
                  __requested_page_size: scenario.pageSize,
                }
              : {}),
            __rate_limit_delay_ms: 1,
          },
        }),
      );
    }
    folder.requests = server.requests(folderKey);
    const comparison = compareRuns(inProcess, folder);
    const error = inProcess.error ?? folder.error;
    results.push({
      entity,
      scenario: scenario.name,
      ...comparison,
      timestampsFellBackToNow: [
        inProcess.timestamps?.fellBackToNow ?? 0,
        folder.timestamps?.fellBackToNow ?? 0,
      ],
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

export const CHECK_VARIANTS = ["valid", "errors", "revoked", "bad-headers"];

/**
 * `check` on both sides: a working endpoint, one answering GraphQL
 * `errors`, a 401, and headers that are not JSON (no request at all).
 */
export async function checkParity({ makeInProcess, server }) {
  const outcomes = [];
  for (const variant of CHECK_VARIANTS) {
    const suffix =
      variant === "valid" || variant === "bad-headers" ? "" : `_${variant}`;
    const inKey = `gql_test_inprocess_check_${variant}${suffix}`;
    const folderKey = `gql_test_folder_check_${variant}${suffix}`;
    const config = token => {
      const base = testConfig(token, server);
      const { queries: _queries, ...connection } = base;
      return variant === "bad-headers"
        ? { ...connection, headers: "{not json" }
        : connection;
    };
    const inResult = await makeInProcess(config(inKey)).testConnection();
    const folderRun = await runFolderCommand("check", {
      config: config(folderKey),
    });
    const status = folderRun.messages.find(
      m => m.type === "CONNECTION_STATUS",
    )?.connectionStatus;
    outcomes.push({
      variant,
      inProcess: inResult.success,
      folder: status?.status === "SUCCEEDED",
      folderMessage: status?.message,
      requests: server.requests(inKey).length,
      requestsEqual: sameList(
        server.requests(inKey),
        server.requests(folderKey),
      ),
    });
  }
  return outcomes;
}

export function formatReport(results) {
  const scenarios = [...new Set(results.map(r => r.scenario))];
  const entities = [...new Set(results.map(r => r.entity))];
  const lines = [
    ["query", ...scenarios.map(s => `${s}: rows, chunks, requests`)].join(
      " | ",
    ),
  ];
  for (const entity of entities) {
    const cells = [entity];
    for (const scenario of scenarios) {
      const r = results.find(
        x => x.entity === entity && x.scenario === scenario,
      );
      const problems = [];
      if (!r.keys) problems.push("keys");
      if (!r.order) problems.push("order");
      if (!r.columns) problems.push("columns");
      if (r.checksumMismatches.length)
        problems.push(`${r.checksumMismatches.length} checksums`);
      if (!r.chunkStates) problems.push("chunk states");
      if (!r.requestsEqual) problems.push("requests");
      if (r.timestampMismatches.length)
        problems.push(`${r.timestampMismatches.length} timestamps`);
      if (r.error) problems.push(`error (${r.error})`);
      cells.push(
        `${r.rows[0]}/${r.rows[1]}, ${r.chunks[0]}/${r.chunks[1]}, ${r.requests[0]}/${r.requests[1]}, ${r.ok ? "match" : `DIFF ${problems.join(", ")}`}`,
      );
    }
    lines.push(cells.join(" | "));
  }
  return lines.join("\n");
}

/** Form fields, compared on what a user sees and what decides encryption. */
export function compareForm(inProcessFields, folderFields) {
  const shape = field => ({
    name: field.name,
    label: field.label,
    type: field.type,
    required: Boolean(field.required),
    default: field.default,
    helperText: field.helperText,
    placeholder: field.placeholder,
    rows: field.rows,
    encrypted: Boolean(field.encrypted),
    ...(field.itemFields ? { itemFields: field.itemFields.map(shape) } : {}),
  });
  const a = (inProcessFields ?? []).map(shape);
  const b = (folderFields ?? []).map(shape);
  return { ok: canonicalJson(a) === canonicalJson(b), inProcess: a, folder: b };
}

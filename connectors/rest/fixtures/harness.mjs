/**
 * Fixture harness for the REST folder: a local REST API that replays
 * recorded cassettes (or emulates the dataset, to record them), and helpers
 * that run the folder the way the SDK runner and the engine do.
 *
 * The in-process connector this folder was ported from is deleted. The
 * rows, chunk positions and requests it was checked against are kept as
 * golden files (`golden.mjs`, one per scenario and entity), and an API test
 * compares the folder with them byte for byte.
 *
 * In replay mode the server answers only requests it has a cassette for, so
 * a folder that sends a request the cassettes lack fails with a cassette
 * miss. Every request is logged with the header that carried the credential
 * and its content type. This file has no dependency on the API.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { ENTITIES, ROUTES } from "./dataset.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const FOLDER = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(FOLDER, "../..");
export const SDK_DIR = path.join(REPO_ROOT, "packages/connector-sdk");
export const RUNNER = path.join(SDK_DIR, "bin/mako-connector.js");
export const CASSETTE_DIR = path.join(here, "cassettes");
export { ENTITIES };

/** The incremental anchor of the `since` scenarios. */
export const SINCE = "2026-01-01T00:00:00.000Z";
export const CONNECTION_ID = "ds_fixture";
export const WORKSPACE_ID = "ws_fixture";

export const SCENARIOS = [
  // One request per chunk: every page, offset and cursor crosses a boundary.
  { name: "chunked", maxIterations: 1 },
  // Two rows a page (a probe's batch size), one page per chunk. It wins
  // over every entity's own `batch_size`.
  { name: "small-pages", maxIterations: 1, pageSize: 2 },
  // The engine's default chunk of 10 requests.
  { name: "default", maxIterations: 10 },
  // Incremental: the client filter on updated_at, and `updated_after` sent.
  { name: "since", maxIterations: 10, since: SINCE },
  // The credential in `X-API-Key` instead of a bearer token.
  { name: "api-key", maxIterations: 10, headerStyle: "api-key" },
  // The connection's `sync_batch_size`: it applies to an entity with no
  // `batch_size` of its own, and to no other.
  { name: "settings-batch", maxIterations: 10, settingsBatch: 6 },
];

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

/** `GET /api/v1/x?a=1`, the query string as sent, a body canonical. */
export function requestKey(method, rawUrl, body = "") {
  const url = new URL(rawUrl, "http://rest.local");
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
  const key = req.headers["x-api-key"];
  if (key) return { token: String(key), style: "api-key" };
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

const failure = (status, message) => ({
  status,
  body: { error: message },
});

/**
 * A local REST API under `/api`. Every request is logged under the token
 * that sent it, with the header that carried it and its content type. Only
 * `rest_test_` tokens are served. A token with `_revoked` gets 401, with
 * `_notfound` a 404 on `/api/`, with `_error500` a 500 on everything. A
 * token with `_redirect_ok` gets a 302 from `/api/` to `/api/final`.
 */
async function startServer(answer) {
  const log = new Map();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      const key = requestKey(req.method ?? "GET", req.url ?? "/", body);
      const { token, style } = credential(req);
      if (!log.has(token)) log.set(token, []);
      log.get(token).push({
        key,
        style,
        type: String(req.headers["content-type"] ?? "none"),
      });

      let response;
      let headers = {};
      const path = new URL(req.url ?? "/", "http://rest.local").pathname;
      if (!token.startsWith("rest_test_")) {
        response = failure(
          401,
          "Only rest_test_ tokens are served by the fixture server.",
        );
      } else if (token.includes("_revoked")) {
        response = failure(401, "invalid token");
      } else if (token.includes("_error500")) {
        response = failure(500, "upstream exploded");
      } else if (token.includes("_notfound") && path === "/api/") {
        response = failure(404, "no root");
      } else if (token.includes("_redirect_metadata") && path === "/api/") {
        // A redirect toward the metadata address: the folder must refuse it.
        response = { status: 307, body: {} };
        headers = { location: "http://169.254.169.254/computeMetadata/v1/" };
      } else if (token.includes("_redirect_ok") && path === "/api/") {
        response = { status: 302, body: {} };
        headers = { location: "/api/final" };
      } else {
        response = answer(key, req.method ?? "GET", req.url ?? "/", body);
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
      (log.get(token) ?? []).map(
        ({ key, style, type }) => `${key} (${style}; ${type})`,
      ),
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
    return failure(404, `No cassette for ${key}`);
  });
  return { ...server, misses };
}

/** Record: answer from the dataset's resolvers, and keep every interaction. */
export async function startRecordingServer() {
  const recorded = new Map();
  const server = await startServer((key, method, rawUrl, body) => {
    const response = emulate(method, rawUrl, body);
    recorded.set(key, response);
    return response;
  });
  return { ...server, recorded };
}

function emulate(method, rawUrl, body) {
  const url = new URL(rawUrl, "http://rest.local");
  if (
    method === "GET" &&
    (url.pathname === "/api/" || url.pathname === "/api/final")
  ) {
    return { status: 200, body: { ok: true } };
  }
  const route = ROUTES.find(
    r => r.method === method && r.path === url.pathname,
  );
  if (!route) return failure(404, `unknown route ${method} ${url.pathname}`);
  return {
    status: 200,
    body: route.resolve({
      query: Object.fromEntries(url.searchParams),
      body: body ? JSON.parse(body) : undefined,
    }),
  };
}

// ---------------------------------------------------------------------------
// Running the folder
// ---------------------------------------------------------------------------

const scratch = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "mako-rest-fixture-"));

/** A connection config for `token` against `server`, with the entities. */
export function testConfig(token, server, scenario = {}) {
  const headers =
    scenario.headerStyle === "api-key"
      ? { "X-API-Key": token }
      : { Authorization: `Bearer ${token}` };
  return {
    // A trailing slash on purpose: the entity paths start with one too.
    api_base_url: `${server.url}/api/`,
    headers: JSON.stringify(headers),
    entities: ENTITIES,
  };
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
    page: source?.page ?? 1,
    offset: source?.offset ?? 0,
    cursor: source?.cursor ?? null,
    totalProcessed: source?.totalProcessed ?? 0,
    totalCount: count === undefined || count === null ? null : count,
    hasMore: Boolean(hasMore),
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

/** The token of one read: its side, scenario and entity, so a log stays apart. */
export const tokenFor = (side, scenario, entity) =>
  `rest_test_${side}_${scenario.name}_${entity}`;

/**
 * The config a raw runner read of `scenario` runs with, as the engine hands
 * it over: a probe's page size, or the connection's `sync_batch_size`.
 */
export function scenarioConfig(token, server, scenario) {
  return {
    ...testConfig(token, server, scenario),
    ...(scenario.pageSize
      ? {
          __page_size: scenario.pageSize,
          __requested_page_size: scenario.pageSize,
        }
      : {}),
    ...(scenario.settingsBatch ? { __page_size: scenario.settingsBatch } : {}),
    __rate_limit_delay_ms: 1,
  };
}

/**
 * Drive `SandboxedConnector` chunk by chunk, as the engine does: its schema
 * first, then `fetchEntityChunk` until `hasMore` is false. The position
 * after each chunk is read from its STATE message.
 */
export async function readBoxed(
  connector,
  { entity, since, maxIterations, pageSize },
) {
  const rows = [];
  const chunks = [];
  let state;
  await connector.resolveSchema?.(entity);
  for (let chunk = 0; chunk < 1000; chunk++) {
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
      onProgress: () => {},
    });
    chunks.push(
      streamPosition(state?.metadata?.stream?.stream_state, state?.hasMore),
    );
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

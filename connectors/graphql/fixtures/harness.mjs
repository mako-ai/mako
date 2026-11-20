/**
 * Fixture harness for the GraphQL folder: a local GraphQL endpoint that
 * replays recorded cassettes (or emulates the dataset, to record them), and
 * helpers that run the folder the way the SDK runner and the engine do.
 *
 * The in-process connector this folder was ported from is deleted. The
 * rows it produced are kept as golden files (`golden.mjs`, one per scenario
 * and query) and an API test compares the folder with them byte for byte.
 *
 * In replay mode the server answers only requests it has a cassette for, so
 * a folder that sends a request the cassettes lack fails with a cassette
 * miss. This file has no dependency on the API.
 */
import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
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
export const CONNECTION_ID = "ds_fixture";
export const WORKSPACE_ID = "ws_fixture";

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
      } else if (token.includes("_redirect")) {
        // A redirect toward the metadata address: the folder must refuse it.
        response = { status: 307, body: {} };
        headers = { location: "http://169.254.169.254/computeMetadata/v1/" };
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
  fs.mkdtempSync(path.join(os.tmpdir(), "mako-graphql-fixture-"));

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

/** The token of one read: its side, scenario and query, so a log stays apart. */
export const tokenFor = (side, scenario, entity) =>
  `gql_test_${side}_${scenario.name}_${entity}${scenario.rateLimited ? "_ratelimit" : ""}`;

/** The config a read of `scenario` runs with, as the engine hands it over. */
export function scenarioConfig(token, server, scenario) {
  return {
    ...testConfig(token, server, scenario),
    ...(scenario.pageSize
      ? {
          __page_size: scenario.pageSize,
          __requested_page_size: scenario.pageSize,
        }
      : {}),
    __rate_limit_delay_ms: 1,
  };
}

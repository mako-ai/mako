/**
 * Parity harness: the in-process BigQuery connector and this folder, run
 * against the same recorded BigQuery responses, compared query by query.
 *
 * Both connectors reach a local server: the service account's `token_uri`
 * and the connection's `api_base_url` point at it. In replay mode the
 * server answers BigQuery calls only from cassettes, so a folder that sends
 * a different request fails with a cassette miss, and the request logs are
 * compared as well.
 *
 * The token endpoint is emulated, never recorded: each run signs its own
 * JWT, so the assertion differs every second. The server verifies the
 * signature with the test key's public half, checks the claims, and logs
 * `iss`, `scope` and `aud`. A token request is part of every compared log.
 *
 * The test key is generated in memory when this file loads. No private key
 * is committed, and the cassettes hold no token.
 *
 * For each query and scenario it compares row count, keys, order, columns,
 * a SHA-256 per row, the chunk positions (page token, job, location, rows
 * processed, hasMore), the exact requests (bodies and job labels
 * included) and each row's source timestamp.
 *
 * In-process BigQuery never retries a request: a 429 or a 5xx fails the
 * chunk, and the engine runs the chunk again from its last state. The
 * harness does the same for both sides (`CHUNK_ATTEMPTS`).
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { CONNECTION_QUERIES, QUERIES } from "./dataset.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const FOLDER = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(FOLDER, "../..");
export const SDK_DIR = path.join(REPO_ROOT, "packages/connector-sdk");
export const RUNNER = path.join(SDK_DIR, "bin/mako-connector.js");
export const CASSETTE_DIR = path.join(here, "cassettes");
export { CONNECTION_QUERIES };

export const PROJECT_ID = "parity-project";
export const CONNECTION_ID = "ds_parity";
export const WORKSPACE_ID = "ws_parity";
export const SINCE = "2026-01-01T00:00:00.000Z";
/** Where the emulated jobs run when the connection names no location. */
export const JOB_LOCATION = "EU";
export const CHUNK_ATTEMPTS = 3;

export const SCENARIOS = [
  // One page per chunk: every page token crosses a chunk boundary.
  { name: "chunked", maxIterations: 1 },
  // Two rows a page for queries without their own batch size.
  { name: "small-pages", maxIterations: 1, pageSize: 2 },
  // The engine's default chunk of 10 pages.
  { name: "default", maxIterations: 10 },
  // The connection names a location: it goes in the job request.
  { name: "location", maxIterations: 10, location: "EU" },
  // An incremental anchor, which BigQuery ignores on both sides.
  { name: "since", maxIterations: 10, since: SINCE },
];

/** A 429 on the job request and a 503 on the first page fetch. */
export const RATE_LIMIT_SCENARIO = {
  name: "rate-limited",
  maxIterations: 1,
  rateLimited: true,
};

/** The service account's key: generated here, never written anywhere. */
const KEYS = crypto.generateKeyPairSync("rsa", { modulusLength: 2048 });
export const TEST_PRIVATE_KEY = KEYS.privateKey.export({
  type: "pkcs8",
  format: "pem",
});

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

/** `GET /x?b=2&a=1` -> `GET /x?a=1&b=2`, decoded; a JSON body canonical. */
export function requestKey(method, rawUrl, body = "") {
  const url = new URL(rawUrl, "http://bigquery.local");
  const pairs = [...url.searchParams.entries()].sort(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b),
  );
  const query = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  let suffix = "";
  if (body) {
    try {
      suffix = ` ${canonicalJson(JSON.parse(body))}`;
    } catch {
      suffix = ` ${body}`;
    }
  }
  return `${method} ${url.pathname}${query ? `?${query}` : ""}${suffix}`;
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
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json")))
    fs.unlinkSync(path.join(dir, file));
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

const bqError = (status, reason, message) => ({
  status,
  body: {
    error: {
      code: status,
      message,
      errors: [{ reason, message }],
      status: reason.toUpperCase(),
    },
  },
});

const decode = part =>
  JSON.parse(Buffer.from(part, "base64url").toString("utf8"));

/**
 * The token endpoint: a JWT-bearer grant whose assertion must verify with
 * the test key. The access token names the run (`iss` before the `@`).
 */
function exchangeToken(body, url) {
  const form = new URLSearchParams(body);
  if (
    form.get("grant_type") !== "urn:ietf:params:oauth:grant-type:jwt-bearer"
  ) {
    return {
      response: { status: 400, body: { error: "unsupported_grant_type" } },
      run: "",
      key: "POST /token (bad grant)",
    };
  }
  const [header, payload, signature] = String(
    form.get("assertion") ?? "",
  ).split(".");
  const verified = crypto
    .createVerify("RSA-SHA256")
    .update(`${header}.${payload}`)
    .verify(KEYS.publicKey, Buffer.from(signature ?? "", "base64url"));
  const claims = verified ? decode(payload) : {};
  const run = String(claims.iss ?? "").split("@")[0];
  const key = `POST /token jwt iss=${claims.iss} scope=${claims.scope} aud=${claims.aud === `${url}/token` ? "<token_uri>" : claims.aud} alg=${decode(header).alg} ttl=${claims.exp - claims.iat}`;
  if (!verified)
    return {
      response: { status: 400, body: { error: "invalid_grant" } },
      run,
      key: `${key} (bad signature)`,
    };
  if (run.includes("revoked")) {
    return {
      response: {
        status: 400,
        body: {
          error: "invalid_grant",
          error_description: "Invalid JWT Signature.",
        },
      },
      run,
      key,
    };
  }
  return {
    response: {
      status: 200,
      body: {
        access_token: `ya29.parity.${run}`,
        expires_in: 3599,
        token_type: "Bearer",
      },
    },
    run,
    key,
  };
}

/**
 * A local BigQuery. Requests are logged per run (the service account's
 * name), token requests included. A run with `ratelimit` in its name gets a
 * 429 on its first job request and a 503 on its first page fetch; one with
 * `denied` gets a 403 on every job request.
 */
async function startServer(answer) {
  const log = new Map();
  const limited = new Map();
  const logFor = run => {
    if (!log.has(run)) log.set(run, []);
    return log.get(run);
  };
  let url = "";
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      let response;
      if (req.url === "/token") {
        const token = exchangeToken(body, url);
        logFor(token.run).push(token.key);
        response = token.response;
      } else {
        const key = requestKey(req.method ?? "GET", req.url ?? "/", body);
        const auth = String(req.headers.authorization ?? "");
        const run = auth.startsWith("Bearer ya29.parity.")
          ? auth.slice("Bearer ya29.parity.".length)
          : "";
        logFor(run).push(key);
        const seen = limited.get(run) ?? { post: false, get: false };
        if (!run) {
          response = bqError(
            401,
            "unauthorized",
            "Request had invalid authentication credentials.",
          );
        } else if (
          run.includes("ratelimit") &&
          req.method === "POST" &&
          !seen.post
        ) {
          limited.set(run, { ...seen, post: true });
          response = bqError(
            429,
            "rateLimitExceeded",
            "Exceeded rate limits: too many concurrent queries",
          );
        } else if (
          run.includes("ratelimit") &&
          req.method === "GET" &&
          !seen.get
        ) {
          limited.set(run, { ...seen, get: true });
          response = bqError(
            503,
            "backendError",
            "Backend error. Job aborted.",
          );
        } else if (run.includes("denied") && req.method === "POST") {
          response = bqError(
            403,
            "accessDenied",
            "User does not have bigquery.jobs.create permission",
          );
        } else {
          response = answer(key, req, body);
        }
      }
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${server.address().port}`;
  return {
    url,
    requests: run => [...(log.get(run) ?? [])],
    requestKeys: run =>
      (log.get(run) ?? []).filter(key => !key.startsWith("POST /token")),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

export async function startReplayServer(interactions = loadCassettes()) {
  const misses = [];
  const server = await startServer(key => {
    const hit = interactions.get(key);
    if (hit) return hit;
    misses.push(key);
    return bqError(404, "notFound", `No cassette for ${key}`);
  });
  return { ...server, misses };
}

export async function startRecordingServer() {
  const recorded = new Map();
  const server = await startServer((key, req, body) => {
    const response = emulate(req, body);
    recorded.set(key, response);
    return response;
  });
  return { ...server, recorded };
}

const tokenFor = offset => Buffer.from(`page ${offset}`).toString("base64");

function page(def, jobId, offset, maxResults) {
  const rows = def.rows.slice(offset, offset + maxResults);
  const next =
    offset + maxResults < def.rows.length
      ? tokenFor(offset + maxResults)
      : undefined;
  return {
    kind: "bigquery#getQueryResultsResponse",
    jobReference: { projectId: PROJECT_ID, jobId, location: JOB_LOCATION },
    schema: def.schema,
    totalRows: String(def.rows.length),
    ...(rows.length ? { rows } : {}),
    ...(next ? { pageToken: next } : {}),
    jobComplete: true,
    cacheHit: false,
  };
}

/**
 * `jobs.query` and `jobs.getQueryResults`, for the queries in the dataset.
 * A `slow` query's job is never complete in its `jobs.query` answer, so the
 * first poll always runs; the poll returns the first page.
 */
function emulate(req, body) {
  const url = new URL(req.url, "http://bigquery.local");
  const base = `/bigquery/v2/projects/${PROJECT_ID}/queries`;
  if (req.method === "POST" && url.pathname === base) {
    const request = JSON.parse(body);
    if (request.query === "SELECT 1 AS one") {
      return {
        status: 200,
        body: {
          jobReference: {
            projectId: PROJECT_ID,
            jobId: "job_check",
            location: JOB_LOCATION,
          },
          schema: { fields: [{ name: "one", type: "INTEGER" }] },
          rows: [{ f: [{ v: "1" }] }],
          totalRows: "1",
          jobComplete: true,
        },
      };
    }
    const def = QUERIES.find(q => q.query === request.query);
    if (!def) return bqError(400, "invalidQuery", "Unrecognized query");
    const jobId = `job_${def.name}`;
    if (def.slow) {
      return {
        status: 200,
        body: {
          jobReference: {
            projectId: PROJECT_ID,
            jobId,
            location: JOB_LOCATION,
          },
          jobComplete: false,
        },
      };
    }
    return {
      status: 200,
      body: page(def, jobId, 0, Number(request.maxResults)),
    };
  }
  const match = new RegExp(`^${base}/([^/]+)$`).exec(url.pathname);
  if (req.method === "GET" && match) {
    const def = QUERIES.find(q => `job_${q.name}` === match[1]);
    if (!def) return bqError(404, "notFound", "Not found: Job");
    const token = url.searchParams.get("pageToken");
    const offset = token
      ? Number(Buffer.from(token, "base64").toString("utf8").split(" ")[1])
      : 0;
    return {
      status: 200,
      body: page(
        def,
        match[1],
        offset,
        Number(url.searchParams.get("maxResults")),
      ),
    };
  }
  return bqError(404, "notFound", "Not found");
}

// ---------------------------------------------------------------------------
// Running the two connectors
// ---------------------------------------------------------------------------

const scratch = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "mako-bigquery-parity-"));

/** The service-account JSON for one run, as a user pastes it. */
export function serviceAccountJson(run, server) {
  return JSON.stringify({
    type: "service_account",
    project_id: PROJECT_ID,
    private_key_id: "parity",
    private_key: TEST_PRIVATE_KEY,
    client_email: `${run}@${PROJECT_ID}.iam.gserviceaccount.com`,
    token_uri: `${server.url}/token`,
  });
}

export function testConfig(run, server, scenario = {}) {
  return {
    service_account_json: serviceAccountJson(run, server),
    project_id: PROJECT_ID,
    api_base_url: server.url,
    ...(scenario.location ? { location: scenario.location } : {}),
    queries: CONNECTION_QUERIES,
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

export function streamPosition(source, hasMore) {
  return {
    pageToken: source?.pageToken ?? null,
    jobId: source?.jobId ?? null,
    jobLocation: source?.jobLocation ?? null,
    totalRows: source?.totalRows ?? null,
    totalProcessed: source?.totalProcessed ?? 0,
    hasMore: Boolean(hasMore),
  };
}

export function chunkPosition(state) {
  const stream = state?.metadata?.stream?.stream_state;
  if (stream) return streamPosition(stream, state.hasMore);
  return streamPosition(
    {
      pageToken: state?.cursor,
      jobId: state?.metadata?.jobId,
      jobLocation: state?.metadata?.jobLocation,
      totalRows: state?.metadata?.totalRows,
      totalProcessed: state?.totalProcessed,
    },
    state?.hasMore,
  );
}

/** Drive the folder chunk by chunk through the bare runner, retrying a failed chunk. */
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
    let result;
    for (let attempt = 1; ; attempt++) {
      result = await runFolderCommand("read", {
        config,
        catalog: {
          streams: [{ stream: { name: entity }, sync_mode: "incremental" }],
        },
        state,
        maxIterations,
      });
      const failure = folderFailure(result);
      if (!failure) break;
      if (attempt >= CHUNK_ATTEMPTS)
        throw new Error(`folder read of ${entity} failed: ${failure}`);
    }
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

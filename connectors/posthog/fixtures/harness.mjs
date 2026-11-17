/**
 * Parity harness: the in-process PostHog connector and this folder, run
 * against the same recorded PostHog responses, compared entity by entity.
 *
 * Both connectors talk to a local HTTP server through `api_base_url`. In
 * replay mode the server answers only requests it has a cassette for, so a
 * folder that sends a different request than the in-process connector fails
 * with a cassette miss, and the request logs are compared as well.
 *
 * For each entity and scenario it compares:
 * - row count, key set and row order;
 * - column set (the union of fields across rows);
 * - a SHA-256 checksum per row, over canonical JSON;
 * - the chunk sequence: the resume position and hasMore after every chunk
 *   (`offset` for the list entities; survey and response offsets, the
 *   current survey and `surveysDone` for `survey_responses`);
 * - the exact request sequence each connector sent, with the auth header
 *   style it used (Bearer or `POSTHOG-API-TOKEN`);
 * - each row's source timestamp, as each connector resolves it.
 *
 * The folder side runs one of two ways. Given `makeBoxed`, it runs through
 * the API's `SandboxedConnector`, the adapter a box uses, with only the box
 * itself replaced by a local process. Without it, the SDK runner is driven
 * directly (`readFolder`), as `parity.mjs` does.
 *
 * This file has no dependency on the API. The caller passes the in-process
 * connector in (see `parity.mjs` and the API test that imports this file).
 */
import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const FOLDER = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(FOLDER, "../..");
export const SDK_DIR = path.join(REPO_ROOT, "packages/connector-sdk");
export const RUNNER = path.join(SDK_DIR, "bin/mako-connector.js");
export const CASSETTE_DIR = path.join(here, "cassettes");
export const PROJECT_ID = "41234";
/**
 * A project the key cannot read surveys in (no `survey:read` there), for
 * the check's HogQL fallback. A project of its own, because cassettes are
 * keyed by request, never by key.
 */
export const NO_SURVEYS_PROJECT_ID = "41235";

/** The incremental anchor the `since` scenarios use. */
export const SINCE = "2026-01-01T00:00:00.000Z";

export const SCENARIOS = [
  // One request per chunk at the default page size of 100: the boundaries
  // of the 230-response survey and the 105 annotations, and every survey
  // lookup of the response walk on its own.
  { name: "chunked", maxIterations: 1 },
  // Two rows per page, one page per chunk: every list of 3 rows or more
  // resumes from an offset at least once.
  { name: "small-pages", maxIterations: 1, pageSize: 2 },
  // The engine's default chunk of 10 requests.
  { name: "default", maxIterations: 10 },
  // Incremental: a client filter on `created_at` for the lists, the
  // responses API's own `since` for responses.
  { name: "since", maxIterations: 10, since: SINCE },
  // RealAdvisor's posthog_crm flow: incremental, 2000 rows per page.
  { name: "flow", maxIterations: 10, pageSize: 2000, since: SINCE },
  // A project API key: the `POSTHOG-API-TOKEN` header instead of Bearer.
  { name: "project-key", maxIterations: 10, authType: "project_api_key" },
];

/**
 * Make the folder runnable the way a box would. It has no dependency of its
 * own; the SDK is provided by the runtime (here, the repo's copy).
 */
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

/**
 * `GET /x?b=2&a=1` -> `GET /x?a=1&b=2`, decoded, so encodings agree. A body
 * (the HogQL probe) is part of the key, as canonical JSON.
 */
export function requestKey(method, rawUrl, body = "") {
  const url = new URL(rawUrl, "http://posthog.local");
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

/** The key a request carries, and which header carried it. */
function credential(req) {
  const header = String(req.headers.authorization ?? "");
  if (header.startsWith("Bearer ")) {
    return { apiKey: header.slice(7), style: "bearer" };
  }
  const token = req.headers["posthog-api-token"];
  if (token) return { apiKey: String(token), style: "project-token" };
  return { apiKey: "", style: "none" };
}

const posthogError = (status, code, detail) => ({
  status,
  body: { type: "authentication_error", code, detail, attr: null },
});

/** Every cassette file, merged into one request -> response map. */
export function loadCassettes(dir = CASSETTE_DIR) {
  const interactions = new Map();
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const entries = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const entry of entries) {
      interactions.set(entry.request, {
        status: entry.status,
        body: entry.body,
      });
    }
  }
  return interactions;
}

/** One file per entity, one interaction per line, so diffs stay readable. */
export function saveCassettes(byFile, dir = CASSETTE_DIR) {
  fs.mkdirSync(dir, { recursive: true });
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    fs.unlinkSync(path.join(dir, file));
  }
  for (const [name, interactions] of byFile) {
    const lines = [...interactions].map(([request, response]) =>
      JSON.stringify({
        request,
        status: response.status,
        body: response.body,
      }),
    );
    fs.writeFileSync(
      path.join(dir, `${name}.json`),
      `[\n${lines.join(",\n")}\n]\n`,
    );
  }
}

/**
 * A local PostHog. `answer(key, url, apiKey)` returns `{ status, body }`.
 *
 * Every request is logged under the API key that sent it, which is how
 * concurrent runs keep separate logs, with the header style it used. Only
 * `phx_test_` keys are served: anything else (a real personal or project
 * key) is refused before anything else happens.
 */
async function startServer(answer) {
  const log = new Map();
  const server = http.createServer((req, res) => {
    let body = "";
    req.on("data", chunk => (body += chunk));
    req.on("end", () => {
      const key = requestKey(req.method ?? "GET", req.url ?? "/", body);
      const { apiKey, style } = credential(req);
      if (!log.has(apiKey)) log.set(apiKey, []);
      log.get(apiKey).push({ key, style });

      let response;
      if (!apiKey.startsWith("phx_test_")) {
        response = posthogError(
          401,
          "authentication_failed",
          "Only phx_test_ keys are served by the fixture server.",
        );
      } else if (apiKey.includes("_revoked")) {
        response = posthogError(
          401,
          "authentication_failed",
          "Personal API key found in request is invalid.",
        );
      } else {
        response = answer(key, req.url ?? "/", apiKey);
      }
      res.writeHead(response.status, { "content-type": "application/json" });
      res.end(JSON.stringify(response.body));
    });
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  const url = `http://127.0.0.1:${port}`;
  return {
    url,
    /** `GET /api/... (bearer)`, in order. */
    requests: apiKey =>
      (log.get(apiKey) ?? []).map(({ key, style }) => `${key} (${style})`),
    /** The bare request keys, as cassettes store them. */
    requestKeys: apiKey => (log.get(apiKey) ?? []).map(({ key }) => key),
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
    return {
      status: 404,
      body: {
        type: "invalid_request",
        code: "not_found",
        detail: `No cassette for ${key}`,
      },
    };
  });
  return { ...server, misses };
}

/**
 * Record: answer from an emulated PostHog over `dataset`, and keep every
 * interaction. Implements only what the connectors call.
 */
export async function startRecordingServer(dataset) {
  const recorded = new Map();
  const server = await startServer((key, rawUrl) => {
    const response = emulate(dataset, rawUrl);
    recorded.set(key, response);
    return response;
  });
  return { ...server, recorded };
}

/** PostHog's order for these lists: newest first, id to break ties. */
const newestFirst = field => (a, b) => {
  const at = Date.parse(a[field] ?? "") || 0;
  const bt = Date.parse(b[field] ?? "") || 0;
  return (
    bt - at || String(b.id ?? b.uuid).localeCompare(String(a.id ?? a.uuid))
  );
};

/** `next` and `previous` name PostHog's host, so cassettes never hold a port. */
const LINK_BASE = "https://us.posthog.com";

function emulate(dataset, rawUrl) {
  const url = new URL(rawUrl, "http://posthog.local");
  const query = Object.fromEntries(url.searchParams.entries());
  const match = /^\/api\/projects\/([^/]+)\/(.+?)\/?$/.exec(url.pathname);
  if (!match || ![PROJECT_ID, NO_SURVEYS_PROJECT_ID].includes(match[1])) {
    return {
      status: 404,
      body: {
        type: "invalid_request",
        code: "not_found",
        detail: "Not found.",
      },
    };
  }
  const route = match[2];
  const limit = Number(query.limit ?? 100);
  const offset = Number(query.offset ?? 0);

  if (route === "query") {
    return {
      status: 200,
      body: {
        columns: ["1"],
        types: [["1", "UInt8"]],
        results: [[1]],
        hasMore: false,
        is_cached: false,
      },
    };
  }

  // No survey:read in this project: the check then falls back to HogQL.
  if (match[1] === NO_SURVEYS_PROJECT_ID && route.startsWith("surveys")) {
    return {
      status: 403,
      body: {
        type: "authentication_error",
        code: "permission_denied",
        detail: "API key missing required scope 'survey:read'",
        attr: null,
      },
    };
  }

  const responsesRoute = /^surveys\/([^/]+)\/responses$/.exec(route);
  if (responsesRoute) {
    let rows = dataset.surveyResponses.get(responsesRoute[1]);
    if (!rows)
      return {
        status: 404,
        body: {
          type: "invalid_request",
          code: "not_found",
          detail: "Not found.",
        },
      };
    rows = [...rows].sort(newestFirst("submitted_at"));
    if (query.since) {
      const since = Date.parse(query.since);
      rows = rows.filter(r => Date.parse(r.submitted_at) >= since);
    }
    return {
      status: 200,
      body: {
        results: rows.slice(offset, offset + limit),
        has_more: rows.length > offset + limit,
        limit,
        offset,
      },
    };
  }

  const items = dataset.lists[route];
  if (!items)
    return {
      status: 404,
      body: {
        type: "invalid_request",
        code: "not_found",
        detail: "Not found.",
      },
    };
  const list = [...items].sort(newestFirst("created_at"));
  const page = (at, path) =>
    `${LINK_BASE}/api/projects/${PROJECT_ID}/${path}/?limit=${limit}&offset=${at}`;
  return {
    status: 200,
    body: {
      count: list.length,
      next: offset + limit < list.length ? page(offset + limit, route) : null,
      previous: offset > 0 ? page(Math.max(0, offset - limit), route) : null,
      results: list.slice(offset, offset + limit),
    },
  };
}

// ---------------------------------------------------------------------------
// Running the two connectors
// ---------------------------------------------------------------------------

const scratch = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "mako-posthog-parity-"));

/** A test config for `apiKey` against `server`. */
export function testConfig(apiKey, server, scenario = {}) {
  return {
    api_key: apiKey,
    api_base_url: server.url,
    project_id: scenario.projectId ?? PROJECT_ID,
    ...(scenario.authType ? { auth_type: scenario.authType } : {}),
  };
}

/** Run one SDK command on the folder and parse its JSON Lines. */
export function runFolderCommand(
  command,
  { config, catalog, state, maxIterations, maxBytes } = {},
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

const RESPONSE_KEYS = [
  "surveyOffset",
  "responseOffset",
  "currentSurveyId",
  "surveysDone",
];

/**
 * The resume position in a chunk's state, the same shape on both sides:
 * the in-process `FetchState` (offset, or the walk in `metadata`), or the
 * folder's stream state (directly, or inside `SandboxedConnector`'s).
 */
export function chunkPosition(entity, state, hasMore) {
  const stream = state?.metadata?.stream?.stream_state;
  const source =
    stream ?? (entity === "survey_responses" ? state?.metadata : state);
  return streamPosition(entity, source, hasMore);
}

/** The same position, from a folder's own stream state. */
export function streamPosition(entity, source, hasMore) {
  const position =
    entity === "survey_responses"
      ? Object.fromEntries(RESPONSE_KEYS.map(k => [k, source?.[k] ?? null]))
      : { offset: source?.offset ?? null };
  return { ...position, hasMore };
}

/**
 * Drive the folder chunk by chunk, the way `SandboxedConnector` does: the
 * last STATE message goes back as `--state`, until `mako.hasMore` is false.
 */
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
    chunks.push(
      streamPosition(entity, stateMessage?.stream?.stream_state, hasMore),
    );
    if (!hasMore) break;
    state = [stateMessage];
  }
  return { rows, chunks };
}

/**
 * Drive a connector chunk by chunk, as the engine does: its schema first,
 * then `fetchEntityChunk` until `hasMore` is false. Works for the in-process
 * connector and for `SandboxedConnector`.
 */
export async function readInProcess(
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
      // Truthy, so the connector's 200 ms default does not slow the replay.
      rateLimitDelay: 1,
      state,
      onBatch: async batch => {
        rows.push(...batch);
      },
    });
    chunks.push(chunkPosition(entity, state, state.hasMore));
    if (!state.hasMore) break;
  }
  return { rows, chunks };
}

/** Same driver; the name says which side it is reading. */
export const readBoxed = readInProcess;

/**
 * Each row's source timestamp as `connector` resolves it, by row id. A row
 * whose timestamp is within a minute of now fell back to "now".
 */
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

/** Checksum of a row as it lands: through JSON first, on both sides. */
export const rowChecksum = row =>
  crypto
    .createHash("sha256")
    .update(canonicalJson(JSON.parse(JSON.stringify(row))))
    .digest("hex");

const columnsOf = rows =>
  [...new Set(rows.flatMap(row => Object.keys(row)))].sort();
const sameList = (a, b) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * Every comparison for one entity and scenario. `ok` is the conjunction.
 * `timestampMismatches` is reported, never part of `ok`: the caller decides
 * which differences are expected (see the API test).
 */
export function compareRuns(inProcess, folder) {
  const inIds = inProcess.rows.map(row => String(row.id));
  const folderIds = folder.rows.map(row => String(row.id));
  const inSums = new Map(
    inProcess.rows.map(row => [String(row.id), rowChecksum(row)]),
  );
  const folderSums = new Map(
    folder.rows.map(row => [String(row.id), rowChecksum(row)]),
  );
  const checksumMismatches = [...inSums]
    .filter(([id, sum]) => folderSums.get(id) !== sum)
    .map(([id]) => id);
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
    result.requestsEqual;
  return result;
}

/** Run every entity in every scenario against one server. */
export async function runParity({
  entities,
  makeInProcess,
  makeBoxed,
  server,
  scenarios = SCENARIOS,
  concurrency = 4,
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
    const inKey = `phx_test_inprocess_${scenario.name}_${entity}`;
    const folderKey = `phx_test_folder_${scenario.name}_${entity}`;
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
    const inConnector = makeInProcess(testConfig(inKey, server, scenario));
    const inProcess = await run("in-process", () =>
      readInProcess(inConnector, options),
    );
    inProcess.requests = server.requests(inKey);
    let folder;
    if (makeBoxed) {
      const boxed = makeBoxed(testConfig(folderKey, server, scenario));
      folder = await run("folder", () => readBoxed(boxed, options));
      inProcess.timestamps = sourceTimestamps(
        inConnector,
        entity,
        inProcess.rows,
      );
      folder.timestamps = sourceTimestamps(boxed, entity, folder.rows);
    } else {
      folder = await run("folder", () =>
        readFolder({
          ...options,
          config: {
            ...testConfig(folderKey, server, scenario),
            ...(scenario.pageSize ? { __page_size: scenario.pageSize } : {}),
            __rate_limit_delay_ms: 1,
          },
        }),
      );
    }
    folder.requests = server.requests(folderKey);
    const comparison = compareRuns(inProcess, folder);
    const error = inProcess.error ?? folder.error;
    // A run that failed is a difference even when both sides failed alike.
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

export const CHECK_VARIANTS = ["valid", "nosurveys", "revoked"];

/**
 * `check` on both sides: a working key, a key without `survey:read` (the
 * HogQL fallback), and a revoked one.
 */
export async function checkParity({ makeInProcess, server }) {
  const outcomes = [];
  for (const variant of CHECK_VARIANTS) {
    const suffix = variant === "valid" ? "" : `_${variant}`;
    const inKey = `phx_test_inprocess_check${suffix}`;
    const folderKey = `phx_test_folder_check${suffix}`;
    const project =
      variant === "nosurveys" ? { projectId: NO_SURVEYS_PROJECT_ID } : {};
    const inResult = await makeInProcess(
      testConfig(inKey, server, project),
    ).testConnection();
    const folderRun = await runFolderCommand("check", {
      config: testConfig(folderKey, server, project),
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

/** A plain-text table, one row per entity, one column group per scenario. */
export function formatReport(results) {
  const scenarios = [...new Set(results.map(r => r.scenario))];
  const entities = [...new Set(results.map(r => r.entity))];
  const header = [
    "entity",
    ...scenarios.map(s => `${s}: rows in/folder, chunks, requests, result`),
  ];
  const lines = [header.join(" | ")];
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
  const systemFields = Object.keys(inProcess?.fields ?? {}).filter(name =>
    ignore.has(name),
  ).length;
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
    systemFields,
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
    options: field.options?.map(o => o.value),
  });
  const a = inProcessFields.map(shape);
  const b = folderFields.map(shape);
  return { ok: canonicalJson(a) === canonicalJson(b), inProcess: a, folder: b };
}

/**
 * Parity harness: the in-process Close connector and this folder, run
 * against the same recorded Close responses, compared entity by entity.
 *
 * Both connectors talk to a local HTTP server: the folder through its
 * `__base_url` config key, the in-process one through an axios client the
 * caller points at the server (it has no base-URL setting). In replay mode
 * the server answers only requests it has a cassette for, so a folder that
 * sends a different request than the in-process connector fails with a
 * cassette miss, and the request logs are compared as well.
 *
 * The clock is frozen at FIXTURE_NOW on both sides: the Search API walk ends
 * one day after "now", and its binary-search probes are computed from it.
 * In the folder process `clock.mjs` also shortens timers under 5 s to 0, so
 * the rate-limit pauses and retry waits do not slow the replay.
 *
 * For each entity and scenario it compares:
 * - row count, key set and row order;
 * - column set (the union of fields across rows);
 * - a SHA-256 checksum per row, over canonical JSON;
 * - each row's source timestamp, as the engine and the connector resolve it;
 * - the chunk sequence: the read position and hasMore after every chunk;
 * - the exact request sequence each connector sent.
 *
 * This file has no dependency on the API. The caller passes the in-process
 * connector and the timestamp resolvers in (`parity.mjs`, and the API test).
 */
import { spawn, spawnSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const here = path.dirname(fileURLToPath(import.meta.url));

export const FOLDER = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(FOLDER, "../..");
export const SDK_DIR = path.join(REPO_ROOT, "packages/connector-sdk");
export const RUNNER = path.join(SDK_DIR, "bin/mako-connector.js");
export const CASSETTE_DIR = path.join(here, "cassettes");
export const CLOCK = path.join(here, "clock.mjs");

/** "Now" for every run: the Search API walk ends a day after it. */
export const FIXTURE_NOW = "2026-11-16T12:00:00.000Z";
/** The incremental anchor of the `since` scenario. */
export const SINCE = "2026-09-01T00:00:00.000Z";

/**
 * Close's own Search page. The in-process connector ignores batch size on
 * Search; the folder pages by `__page_size` when one is set.
 */
export const SEARCH_PAGE_SIZE = 200;
/** The emulator refuses a request naming more custom selectors than this. */
export const SELECTOR_CEILING = 50;
/**
 * The emulator refuses a cursor past this many rows of one query. Close's
 * own limit is about 10,000; calls get a low one so the fixtures reach it.
 */
export const CURSOR_ROW_LIMIT = { "activity.call": 200, default: 10_000 };

export const SCENARIOS = [
  // One page per chunk: every page boundary is a chunk boundary.
  { name: "chunked", maxIterations: 1 },
  // Two rows a page, one page per chunk. The offset lists page by 2 on
  // both sides. On Search the folder pages by 2 too and in-process stays at
  // 200, so those runs differ in requests and chunks by design: the folder
  // reads from the emulator (`dataset.mjs`) and is held to the same rows,
  // in the same order, with no row lost or read twice (`rowsOnly`).
  { name: "small-pages", maxIterations: 1, pageSize: 2, searchRowsOnly: true },
  // The engine's default chunk of 10 pages.
  { name: "default", maxIterations: 10 },
  // Incremental: `date_updated` windows from `since`.
  { name: "since", maxIterations: 10, since: SINCE },
];

/** Leads, contacts, opportunities and activities go through the Search API. */
export const isSearchEntity = entity =>
  ["leads", "contacts", "opportunities"].includes(entity) ||
  entity.startsWith("activities:");

/** The `_limit` of every Search request in a request log. */
export function searchLimits(requests) {
  return requests
    .filter(key => key.startsWith("POST /data/search/ "))
    .map(key => JSON.parse(key.slice("POST /data/search/ ".length))._limit);
}

/** A scenario where every request is answered 429 once before it succeeds. */
export const RATE_LIMIT_SCENARIO = {
  name: "rate-limited",
  maxIterations: 10,
  rateLimited: true,
};
export const RATE_LIMIT_ENTITIES = ["users", "leads", "activities:Call"];

/**
 * What the folder reads on purpose that in-process gets only from webhooks.
 * A poll-only connection (the box has no webhooks yet) needs it to match
 * what a webhook-fed in-process connection holds in the warehouse.
 *
 * Per entity: the extra rows (`row`), columns (`columns`), schema fields
 * (`schemaFields`) and requests (`request`). The comparison leaves them out
 * of the folder's run, holds the rest to in-process exactly, and checks the
 * extras are there (`folderOnlyOk`):
 * - `custom_fields`: activity and custom-object fields, which in-process
 *   writes from `custom_fields.activity.*` / `custom_fields.custom_object.*`
 *   webhooks (with `custom_field_type` null).
 * - `users`: `is_active` from the organization's memberships, and a
 *   deactivated user marked deleted, which in-process writes from the
 *   `membership.deactivated` webhook.
 */
export const FOLDER_ONLY = {
  custom_fields: {
    row: row => ["activity", "custom_object"].includes(row.custom_field_type),
    request: key =>
      key === "GET /custom_field/activity/" ||
      key === "GET /custom_field/custom_object_type/",
    check: ({ rows }) => rows > 0,
  },
  users: {
    columns: ["is_active", "is_deleted", "_mako_deleted_at"],
    schemaFields: ["is_active"],
    request: key => key === "GET /me/" || key.startsWith("GET /organization/"),
    check: ({ requests, folderRows }) =>
      requests > 0 &&
      folderRows.every(row => "is_active" in row) &&
      folderRows.every(
        row => (row.is_active === false) === (row.is_deleted === true),
      ),
  },
};

/** The folder run without its `FOLDER_ONLY` extras, and what was dropped. */
export function withoutFolderOnly(entity, run) {
  const extra = FOLDER_ONLY[entity];
  if (!extra) return { run, folderOnly: undefined };
  const rows = run.rows.filter(row => !extra.row?.(row));
  const columns = extra.columns ?? [];
  const stripped = rows.map(row => {
    if (!columns.some(column => column in row)) return row;
    const copy = { ...row };
    for (const column of columns) delete copy[column];
    return copy;
  });
  const requests = (run.requests ?? []).filter(key => !extra.request?.(key));
  const folderOnly = {
    rows: run.rows.length - rows.length,
    columns: columns.filter(column => rows.some(row => column in row)),
    requests: (run.requests ?? []).length - requests.length,
  };
  folderOnly.ok = Boolean(
    extra.check?.({ ...folderOnly, folderRows: rows }) ?? true,
  );
  return { run: { ...run, rows: stripped, requests }, folderOnly };
}

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

/**
 * Freeze `Date.now` in this process (the in-process side). Returns the
 * restore function. `new Date()` with no argument is left alone.
 */
export function freezeClock() {
  const real = Date.now;
  const frozen = Date.parse(FIXTURE_NOW);
  Date.now = () => frozen;
  return () => {
    Date.now = real;
  };
}

/**
 * Make the folder runnable the way a box would: its own lockfile installed
 * (it has no dependency), and the SDK provided by the runtime.
 */
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

/**
 * `POST /data/search/ {...}`: method, path, decoded and sorted query, and
 * the body as canonical JSON, so encodings and key order agree.
 */
export function requestKey(method, rawUrl, body) {
  const url = new URL(rawUrl, "http://close.local");
  const pairs = [...url.searchParams.entries()].sort(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b),
  );
  const query = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  const pathname = url.pathname.replace(/^\/api\/v1/, "");
  const bodyPart =
    body !== undefined && body !== "" ? ` ${canonicalJson(body)}` : "";
  return `${method} ${pathname}${query ? `?${query}` : ""}${bodyPart}`;
}

function basicKey(req) {
  const header = String(req.headers.authorization ?? "");
  if (!header.startsWith("Basic ")) return "";
  return Buffer.from(header.slice(6), "base64").toString("utf8").split(":")[0];
}

const closeError = (status, body) => ({ status, body });

/**
 * A cassette stores a request as a hash of its key plus the key's first 100
 * characters to read: a Search request names up to 90 fields, and storing
 * whole keys tripled the cassettes' size.
 */
export const requestHash = key =>
  crypto.createHash("sha256").update(key).digest("hex").slice(0, 32);

/** Every cassette file, merged into one request hash -> response map. */
export function loadCassettes(dir = CASSETTE_DIR) {
  const interactions = new Map();
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const entries = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const entry of entries) {
      interactions.set(entry.hash, {
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
        hash: requestHash(request),
        request: request.length > 100 ? `${request.slice(0, 97)}...` : request,
        status: response.status,
        body: response.body,
      }),
    );
    fs.writeFileSync(
      path.join(dir, `${name.replace(/[^a-zA-Z0-9_]/g, "_")}.json`),
      `[\n${lines.join(",\n")}\n]\n`,
    );
  }
}

/**
 * A local Close. `answer(key, method, url, body)` returns `{ status, body }`.
 *
 * Every request is logged under the API key that sent it, which is how
 * concurrent runs keep separate logs. Only `api_test_` keys are served: this
 * server must never see a real key. A key containing `_revoked` gets 401. A
 * key containing `_ratelimit` gets one 429 with `Retry-After: 1` for each
 * distinct request before the real answer, so both sides' retry policies
 * run.
 */
async function startServer(answer) {
  const log = new Map();
  const limited = new Set();
  const server = http.createServer((req, res) => {
    let raw = "";
    req.on("data", chunk => (raw += chunk));
    req.on("end", () => {
      let body;
      try {
        body = raw ? JSON.parse(raw) : undefined;
      } catch {
        body = raw;
      }
      const method = req.method ?? "GET";
      const key = requestKey(method, req.url ?? "/", body);
      const apiKey = basicKey(req);
      if (!log.has(apiKey)) log.set(apiKey, []);
      log.get(apiKey).push(key);

      let response;
      let headers = {};
      if (!apiKey.startsWith("api_test_")) {
        response = closeError(401, { error: "Unauthorized" });
      } else if (apiKey.includes("_revoked")) {
        response = closeError(401, { error: "The API key is not valid." });
      } else if (
        apiKey.includes("_ratelimit") &&
        !limited.has(`${apiKey} ${key}`)
      ) {
        limited.add(`${apiKey} ${key}`);
        response = closeError(429, { error: "Too many requests" });
        headers = { "retry-after": "1" };
      } else {
        response = answer(key, method, req.url ?? "/", body);
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
    url: `http://127.0.0.1:${port}/api/v1`,
    requests: apiKey => [...(log.get(apiKey) ?? [])],
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/** Replay: answer from cassettes only. A miss is a 404 the connector sees. */
export async function startReplayServer(interactions = loadCassettes()) {
  const misses = [];
  const server = await startServer(key => {
    const hit = interactions.get(requestHash(key));
    if (hit) return hit;
    misses.push(key);
    return closeError(404, { error: `No cassette for ${key.slice(0, 300)}` });
  });
  return { ...server, misses };
}

/** Record: answer from the Close emulator over `dataset`, keep everything. */
export async function startRecordingServer(dataset) {
  const recorded = new Map();
  const server = await startServer((key, method, url, body) => {
    const response = emulate(dataset, method, url, body);
    recorded.set(key, response);
    return response;
  });
  return { ...server, recorded };
}

// ---------------------------------------------------------------------------
// The Close emulator: only what the connectors call
// ---------------------------------------------------------------------------

function emulate(dataset, method, rawUrl, body) {
  const url = new URL(rawUrl, "http://close.local");
  const route = url.pathname.replace(/^\/api\/v1/, "");
  const query = Object.fromEntries(url.searchParams.entries());

  if (method === "GET" && route === "/me/") {
    return { status: 200, body: dataset.me };
  }
  const schema = /^\/custom_field_schema\/([a-z_]+)\/$/.exec(route);
  if (method === "GET" && schema) {
    const fields = dataset.schemas[schema[1]];
    if (!fields) return closeError(404, { error: "Not found" });
    return {
      status: 200,
      body: {
        fields: fields.map(f => ({
          id: f.id,
          name: f.name,
          type: f.type,
          accepts_multiple_values: f.accepts_multiple_values,
        })),
      },
    };
  }
  if (
    method === "GET" &&
    route === `/organization/${dataset.organization.id}/`
  ) {
    return { status: 200, body: dataset.organization };
  }
  if (method === "POST" && route === "/data/search/") {
    return search(dataset, body ?? {});
  }
  const list = dataset.lists[route];
  if (method === "GET" && list) return listPage(route, list, query);
  return closeError(404, { error: `Unknown route ${method} ${route}` });
}

function project(row, fields) {
  if (!fields) return row;
  const out = {};
  for (const field of fields) {
    if (field.startsWith("custom.")) {
      const value = row.custom?.[field.slice("custom.".length)];
      if (value !== undefined) out[field] = value;
    } else if (row[field] !== undefined) {
      out[field] = row[field];
    }
  }
  return out;
}

function listPage(route, items, query) {
  // Without `_fields`, `/group/` omits name and members, as Close does.
  const fields = query._fields
    ? query._fields.split(",")
    : route === "/group/"
      ? ["id", "organization_id"]
      : null;
  const limit = query._limit === undefined ? 100 : Number(query._limit);
  const skip = Number(query._skip ?? 0);
  const page = limit === 0 ? [] : items.slice(skip, skip + limit);
  return {
    status: 200,
    body: {
      data: page.map(item => project(item, fields)),
      has_more: limit > 0 && skip + limit < items.length,
      total_results: items.length,
    },
  };
}

const timeOf = value => (value ? Date.parse(value) : Number.NaN);

function matches(row, condition) {
  if (condition.type === "match_all") return true;
  if (condition.type === "or")
    return condition.queries.some(q => matches(row, q));
  if (condition.type === "id") return row.id === condition.value;
  if (condition.type === "field_condition") {
    const value = timeOf(row[condition.field.field_name]);
    if (Number.isNaN(value)) return false;
    const range = condition.condition;
    if (value < Date.parse(range.on_or_after.value)) return false;
    if (range.before && value >= Date.parse(range.before.value)) return false;
    return true;
  }
  throw new Error(`emulator: unsupported query ${JSON.stringify(condition)}`);
}

function search(dataset, body) {
  const [typeQuery, ...conditions] = body.query?.queries ?? [];
  const objectType = typeQuery?.object_type;
  const rows = dataset.search[objectType];
  if (!rows)
    return closeError(400, { error: `Unknown object_type ${objectType}` });

  const fields = body._fields?.[objectType];
  if (fields) {
    const selectors = fields.filter(f => f.startsWith("custom."));
    if (selectors.length > SELECTOR_CEILING) {
      return closeError(400, {
        error: "Bad request",
        "field-errors": { _fields: "Too many fields requested." },
      });
    }
  }

  let result = rows.filter(row => conditions.every(c => matches(row, c)));
  if (body.include_counts && body.results_limit === 0) {
    return {
      status: 200,
      body: { data: [], cursor: null, count: { total: result.length } },
    };
  }
  const sort = body.sort ?? [];
  result = [...result].sort((a, b) => {
    for (const s of sort) {
      const name = s.field.field_name;
      const d = timeOf(a[name]) - timeOf(b[name]);
      if (d !== 0 && !Number.isNaN(d)) return s.direction === "desc" ? -d : d;
    }
    return a.id < b.id ? -1 : a.id > b.id ? 1 : 0;
  });

  // A cursor is bound to its query and sort, and runs out after a limit.
  const signature = crypto
    .createHash("sha256")
    .update(canonicalJson({ query: body.query, sort: body.sort }))
    .digest("hex")
    .slice(0, 16);
  let offset = 0;
  if (body.cursor) {
    let decoded;
    try {
      decoded = JSON.parse(Buffer.from(body.cursor, "base64url").toString());
    } catch {
      decoded = null;
    }
    const limit = CURSOR_ROW_LIMIT[objectType] ?? CURSOR_ROW_LIMIT.default;
    if (!decoded || decoded.s !== signature || decoded.o >= limit) {
      return closeError(400, {
        error: "Bad request",
        "field-errors": { cursor: "Invalid or expired cursor." },
      });
    }
    offset = decoded.o;
  }
  const limit = Number(body._limit ?? 100);
  const page = result.slice(offset, offset + limit);
  const next = offset + limit < result.length;
  return {
    status: 200,
    body: {
      data: page.map(row => project(row, fields)),
      cursor: next
        ? Buffer.from(
            JSON.stringify({ s: signature, o: offset + limit }),
          ).toString("base64url")
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Running the two connectors
// ---------------------------------------------------------------------------

const scratch = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "mako-close-parity-"));

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
      const messages = lines.map(line => JSON.parse(line));
      resolve({ code, messages, stderr, lines });
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

/** The read position of a state, without the incremental anchor. */
const positionOf = state => {
  if (!state) return {};
  const { since: _since, mako: _mako, ...position } = state;
  return position;
};

/**
 * The in-process `FetchState` as a read position: the offset of the offset
 * lists, or the window position of the Search API walk.
 */
export function inProcessPosition(state) {
  if (!state) return {};
  if (typeof state.offset === "number") return { offset: state.offset };
  const m = state.metadata;
  if (!m || !("windowStart" in m)) return {};
  return {
    windowStart: m.windowStart,
    windowEnd: m.windowEnd,
    pageCursor: m.pageCursor,
    lastSeenWindowValue: m.lastSeenWindowValue,
    windowField: m.windowField,
  };
}

/**
 * Drive the folder chunk by chunk, the way `SandboxedConnector` does: the
 * last STATE message goes back as `--state`, until `mako.hasMore` is false.
 * Also measures each chunk's protocol output, the number §8 needs.
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
  for (let chunk = 0; chunk < 2000; chunk++) {
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
    let recordBytes = 0;
    let records = 0;
    result.messages.forEach((message, i) => {
      if (message.type === "RECORD" && message.record.stream === entity) {
        rows.push(message.record.data);
        recordBytes += Buffer.byteLength(result.lines[i]) + 1;
        records++;
      }
    });
    const stateMessage = result.messages
      .filter(m => m.type === "STATE")
      .at(-1)?.state;
    const hasMore = stateMessage?.mako?.hasMore === true;
    chunks.push({
      position: positionOf(stateMessage?.stream?.stream_state),
      hasMore,
      records,
      recordBytes,
    });
    if (!hasMore) break;
    state = [stateMessage];
  }
  return { rows, chunks };
}

/**
 * Drive `SandboxedConnector` (the box path, with the box swapped for a local
 * process) chunk by chunk, as the engine does. `since` goes in as
 * `options.since` on every chunk; the adapter puts it into `state.mako`.
 */
export async function readBoxed(
  connector,
  { entity, since, maxIterations, pageSize },
) {
  const rows = [];
  const chunks = [];
  let state;
  for (let chunk = 0; chunk < 2000; chunk++) {
    let records = 0;
    state = await connector.fetchEntityChunk({
      entity,
      since: since ? new Date(since) : undefined,
      maxIterations,
      ...(pageSize ? { batchSize: pageSize } : {}),
      rateLimitDelay: 1,
      state,
      onBatch: async batch => {
        rows.push(...batch);
        records += batch.length;
      },
    });
    chunks.push({
      position: positionOf(state.metadata?.stream?.stream_state),
      hasMore: state.hasMore,
      records,
    });
    if (!state.hasMore) break;
  }
  return { rows, chunks };
}

/**
 * Drive the in-process connector chunk by chunk, as the engine does, with a
 * fresh connector per chunk: `performSyncChunk` builds one per chunk too, so
 * the custom-field lookups are repeated exactly as in production.
 */
export async function readInProcess(
  makeConnector,
  { entity, since, maxIterations, pageSize },
) {
  const rows = [];
  const chunks = [];
  let state;
  for (let chunk = 0; chunk < 2000; chunk++) {
    let records = 0;
    state = await makeConnector().fetchEntityChunk({
      entity,
      since: since ? new Date(since) : undefined,
      maxIterations,
      ...(pageSize ? { batchSize: pageSize } : {}),
      rateLimitDelay: 1,
      state,
      onBatch: async batch => {
        rows.push(...batch);
        records += batch.length;
      },
    });
    chunks.push({
      position: inProcessPosition(state),
      hasMore: state.hasMore,
      records,
    });
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

const TIMESTAMP_CANDIDATES = [
  "date_updated",
  "updated_at",
  "updatedAt",
  "date_modified",
  "date_created",
  "created_at",
  "createdAt",
  "timestamp",
  "_syncedAt",
];

/**
 * Whether a row carries a time the resolvers can read. A row without one
 * gets "now" from both; it is compared as "fallback", not as two clocks.
 */
export function hasSourceTime(row) {
  return TIMESTAMP_CANDIDATES.some(
    field =>
      row?.[field] && !Number.isNaN(new Date(String(row[field])).getTime()),
  );
}

const columnsOf = rows =>
  [...new Set(rows.flatMap(row => Object.keys(row)))].sort();
const sameList = (a, b) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/**
 * Every comparison for one entity and scenario. `ok` is the conjunction.
 * `sourceTs` maps a row to its resolved source times, one list per side.
 */
export function compareRuns(inProcess, rawFolder, sourceTs, entity) {
  const { run: folder, folderOnly } = withoutFolderOnly(entity, rawFolder);
  const inIds = inProcess.rows.map(row => String(row.id));
  const folderIds = folder.rows.map(row => String(row.id));
  const checksumMismatches = [];
  const timestampMismatches = [];
  let fallbacks = 0;
  const n = Math.min(inProcess.rows.length, folder.rows.length);
  for (let i = 0; i < n; i++) {
    const a = inProcess.rows[i];
    const b = folder.rows[i];
    if (rowChecksum(a) !== rowChecksum(b)) checksumMismatches.push(inIds[i]);
    if (sourceTs) {
      if (!hasSourceTime(a) && !hasSourceTime(b)) {
        fallbacks++;
        continue;
      }
      const ta = sourceTs.inProcess(a);
      const tb = sourceTs.folder(b);
      if (canonicalJson(ta) !== canonicalJson(tb))
        timestampMismatches.push(inIds[i]);
    }
  }
  const strip = chunks =>
    chunks.map(c => ({ position: c.position, hasMore: c.hasMore }));
  const inColumns = columnsOf(inProcess.rows);
  const folderColumns = columnsOf(folder.rows);
  const result = {
    rows: [inProcess.rows.length, folder.rows.length],
    // Rows read twice. The cursor-limit restart re-reads the row it stopped
    // on, on both sides; anything more on the folder side is a bug.
    duplicates: [
      inIds.length - new Set(inIds).size,
      folderIds.length - new Set(folderIds).size,
    ],
    keys: sameList([...new Set(inIds)].sort(), [...new Set(folderIds)].sort()),
    order: sameList(inIds, folderIds),
    columns: sameList(inColumns, folderColumns),
    columnCount: inColumns.length,
    checksumMismatches,
    timestampMismatches,
    timestampFallbacks: fallbacks,
    chunks: [inProcess.chunks.length, folder.chunks.length],
    chunkStates:
      canonicalJson(strip(inProcess.chunks)) ===
      canonicalJson(strip(folder.chunks)),
    requests: [inProcess.requests?.length ?? 0, folder.requests?.length ?? 0],
    requestsEqual: sameList(inProcess.requests ?? [], folder.requests ?? []),
    ...(folderOnly ? { folderOnly } : {}),
  };
  result.ok =
    (folderOnly?.ok ?? true) &&
    result.rows[0] === result.rows[1] &&
    result.duplicates[0] === result.duplicates[1] &&
    result.keys &&
    result.order &&
    result.columns &&
    checksumMismatches.length === 0 &&
    timestampMismatches.length === 0 &&
    result.chunkStates &&
    result.requestsEqual;
  return result;
}

/** Chunk and page sizes of a folder run, for the scale notes. */
export function chunkStats(run) {
  const sizes = run.chunks.map(c => c.recordBytes ?? 0);
  const rows = run.chunks.map(c => c.records ?? 0);
  const totalBytes = sizes.reduce((a, b) => a + b, 0);
  const totalRows = rows.reduce((a, b) => a + b, 0);
  return {
    chunks: run.chunks.length,
    rows: totalRows,
    maxChunkRows: Math.max(0, ...rows),
    maxChunkBytes: Math.max(0, ...sizes),
    bytesPerRow: totalRows ? Math.round(totalBytes / totalRows) : 0,
  };
}

/**
 * Run every entity in every scenario against one server.
 * `makeInProcess(config)` returns a fresh connector for one chunk.
 */
export async function runParity({
  entities,
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
  // The Close emulator, for runs whose requests the cassettes cannot hold.
  let emulator;
  const emulated = () =>
    (emulator ??= import("./dataset.mjs").then(({ buildDataset }) =>
      startRecordingServer(buildDataset()),
    ));
  const work = async ({ entity, scenario }) => {
    const options = {
      entity,
      since: scenario.since,
      maxIterations: scenario.maxIterations,
      pageSize: scenario.pageSize,
    };
    const limited = scenario.rateLimited ? "_ratelimit" : "";
    const tag = entity.replace(/[^a-zA-Z0-9_]/g, "-");
    const inKey = `api_test_inprocess${limited}_${scenario.name}_${tag}`;
    const folderKey = `api_test_folder${limited}_${scenario.name}_${tag}`;
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
        () => makeInProcess({ api_key: inKey, baseUrl: server.url }),
        options,
      ),
    );
    inProcess.requests = server.requests(inKey);
    // Through `SandboxedConnector` when the caller gives one (the API test),
    // else the SDK runner driven directly (`parity.mjs`).
    // Schemas are compared on their own: the box path's `discover` reads
    // every entity's custom fields at once, so it is not part of a read.
    const rowsOnly = Boolean(scenario.searchRowsOnly && isSearchEntity(entity));
    const folderServer = rowsOnly ? await emulated() : server;
    const boxed = makeBoxed?.({
      api_key: folderKey,
      __base_url: folderServer.url,
    });
    const folder = await run("folder", () =>
      boxed
        ? readBoxed(boxed, options)
        : readFolder({
            ...options,
            config: {
              api_key: folderKey,
              __base_url: folderServer.url,
              ...(scenario.pageSize ? { __page_size: scenario.pageSize } : {}),
            },
          }),
    );
    folder.requests = folderServer.requests(folderKey);
    const comparison = compareRuns(inProcess, folder, sourceTs, entity);
    if (rowsOnly) {
      // Same rows, same order, nothing read twice more than in-process, and
      // pages of at most `pageSize` (probes ask for 1).
      const limits = searchLimits(folder.requests);
      comparison.rowsOnly = true;
      comparison.pageSizeHonoured =
        limits.length > 0 &&
        limits.every(limit => limit <= scenario.pageSize) &&
        limits.includes(scenario.pageSize);
      comparison.ok =
        (comparison.folderOnly?.ok ?? true) &&
        comparison.rows[0] === comparison.rows[1] &&
        comparison.duplicates[1] === comparison.duplicates[0] &&
        comparison.keys &&
        comparison.order &&
        comparison.columns &&
        comparison.checksumMismatches.length === 0 &&
        comparison.timestampMismatches.length === 0 &&
        comparison.pageSizeHonoured;
    }
    const error = inProcess.error ?? folder.error;
    results.push({
      entity,
      scenario: scenario.name,
      ...comparison,
      stats: chunkStats(folder),
      error,
      ok: comparison.ok && !error,
    });
  };
  const queue = [...jobs];
  try {
    await Promise.all(
      Array.from({ length: Math.min(concurrency, queue.length) }, async () => {
        while (queue.length > 0) await work(queue.shift());
      }),
    );
  } finally {
    if (emulator) await (await emulator).close();
  }
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
      baseUrl: server.url,
    }).testConnection();
    const folderRun = await runFolderCommand("check", {
      config: { api_key: folderKey, __base_url: server.url },
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
      if (r.duplicates[1] !== r.duplicates[0])
        problems.push(`${r.duplicates[1]}/${r.duplicates[0]} duplicates`);
      if (r.rowsOnly) {
        if (!r.pageSizeHonoured) problems.push("page size");
      } else {
        if (!r.chunkStates) problems.push("chunk states");
        if (!r.requestsEqual) problems.push("requests");
      }
      if (r.folderOnly && !r.folderOnly.ok) problems.push("folder-only extras");
      if (r.error) problems.push(`error (${r.error})`);
      const extras = r.folderOnly
        ? ` (+${r.folderOnly.rows} rows, +${r.folderOnly.columns.length} columns, +${r.folderOnly.requests} requests folder-only)`
        : "";
      cells.push(
        `${r.rows[0]}/${r.rows[1]}, ${r.chunks[0]}/${r.chunks[1]}, ${r.requests[0]}/${r.requests[1]}, ${r.ok ? (r.rowsOnly ? "same rows" : "match") : `DIFF ${problems.join(", ")}`}${extras}`,
      );
    }
    lines.push(cells.join(" | "));
  }
  return lines.join("\n");
}

/** Pages, chunks and bytes per entity in the default scenario. */
export function formatScale(results, scenario = "default") {
  const lines = [
    "entity | rows | chunks | requests | max rows/chunk | max bytes/chunk | bytes/row",
  ];
  for (const r of results.filter(x => x.scenario === scenario)) {
    const s = r.stats;
    lines.push(
      `${r.entity} | ${s.rows} | ${s.chunks} | ${r.requests[1]} | ${s.maxChunkRows} | ${s.maxChunkBytes} | ${s.bytesPerRow}`,
    );
  }
  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Schemas and the credential form
// ---------------------------------------------------------------------------

/**
 * The in-process `ConnectorEntitySchema` against the folder's stream as the
 * engine translates it. Fields in `ignore` (Mako's system columns) are left
 * out. The in-process Close schemas declare no key columns, so the engine
 * merges on its default `["id"]`; the folder declares `["id"]`. The
 * folder's `FOLDER_ONLY` schema fields are left out of its side, and must be
 * there.
 */
export function compareEntitySchema(inProcess, folder, ignore = new Set()) {
  const names = schema =>
    Object.keys(schema?.fields ?? {})
      .filter(name => !ignore.has(name))
      .sort();
  const folderOnly =
    FOLDER_ONLY[inProcess?.entity ?? folder?.entity]?.schemaFields ?? [];
  const inNames = names(inProcess);
  const folderNames = names(folder).filter(name => !folderOnly.includes(name));
  const folderOnlyMissing = folderOnly.filter(
    name => !(name in (folder?.fields ?? {})),
  );
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
    canonicalJson(inProcess?.keyColumns ?? ["id"]) ===
    canonicalJson(folder?.keyColumns);
  const policy = inProcess?.unknownFieldPolicy === folder?.unknownFieldPolicy;
  return {
    fields: [inNames.length, folderNames.length],
    customFields: inNames.filter(name => name.startsWith("custom_cf_")).length,
    missing,
    extra,
    fieldDiffs,
    keyColumns,
    policy,
    folderOnlyMissing,
    ok:
      folderOnlyMissing.length === 0 &&
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
  });
  const a = inProcessFields.map(shape);
  const b = folderFields.map(shape);
  return { ok: canonicalJson(a) === canonicalJson(b), inProcess: a, folder: b };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** Run the folder's webhook handler on a batch, in its own process. */
export function runFolderWebhook(input) {
  const dir = scratch();
  const file = path.join(dir, "batch.json");
  fs.writeFileSync(file, JSON.stringify(input));
  return new Promise((resolve, reject) => {
    const child = spawn(
      process.execPath,
      [path.join(here, "webhook-cli.mjs"), file],
      { cwd: FOLDER, env: folderEnv(), stdio: ["ignore", "pipe", "pipe"] },
    );
    let stdout = "";
    let stderr = "";
    child.stdout.on("data", chunk => (stdout += chunk));
    child.stderr.on("data", chunk => (stderr += chunk));
    child.on("error", reject);
    child.on("close", code => {
      fs.rmSync(dir, { recursive: true, force: true });
      if (code !== 0) reject(new Error(stderr || `exit ${code}`));
      else resolve(JSON.parse(stdout));
    });
  });
}

/** The in-process connector's answer for the same batch, same shape. */
export function inProcessWebhookOutcomes(connector, events) {
  return events.map(({ eventId, eventType, rawPayload }) => {
    if (!connector.getWebhookEventMapping(eventType)) {
      return { eventId, outcome: "unmapped" };
    }
    const records = (
      connector.extractWebhookCdcRecords(rawPayload, eventType) ?? []
    ).filter(Boolean);
    if (records.length === 0) return { eventId, outcome: "extract_failed" };
    return {
      eventId,
      outcome: "records",
      records: records.map(record => ({
        ...record,
        sourceTs: record.sourceTs.toISOString(),
      })),
    };
  });
}

/**
 * Webhook parity: the subscribed events, the signature checks and the
 * change records of every event, in-process against the folder.
 */
export async function webhookParity({ connector, events, deliveries }) {
  const folder = await runFolderWebhook({
    verify: deliveries.map(({ payload, headers, secret }) => ({
      payload,
      headers,
      secret,
    })),
    events,
  });
  const inEvents = connector.getSupportedWebhookEvents();
  const inVerify = await Promise.all(
    deliveries.map(({ payload, headers, secret }) =>
      connector.verifyWebhook({ payload, headers, secret, query: {} }),
    ),
  );
  const verify = deliveries.map((delivery, i) => ({
    name: delivery.name,
    inProcess: inVerify[i].valid,
    folder: folder.verify[i].valid,
    same:
      canonicalJson({ ...inVerify[i] }) ===
      canonicalJson({ ...folder.verify[i] }),
  }));
  const inOutcomes = inProcessWebhookOutcomes(connector, events);
  const outcomes = events.map((event, i) => ({
    eventId: event.eventId,
    eventType: event.eventType,
    outcome: inOutcomes[i].outcome,
    records: inOutcomes[i].records?.length ?? 0,
    same: canonicalJson(inOutcomes[i]) === canonicalJson(folder.outcomes[i]),
  }));
  return {
    eventsSame: sameList(inEvents, folder.events),
    eventCount: inEvents.length,
    verify,
    outcomes,
    ok:
      sameList(inEvents, folder.events) &&
      verify.every(v => v.same) &&
      outcomes.every(o => o.same),
  };
}

/**
 * A factory of in-process connectors pointed at `baseUrl`. The connector has
 * no base-URL setting, so its axios client is built here with the real
 * `createCloseClient` (retry policy and rate gate included) and aimed at
 * the fixture server. Waits are stubbed; the request sequence is not.
 */
export function inProcessFactory({ CloseConnector, createCloseClient }) {
  return ({ api_key, baseUrl }) => {
    const connector = new CloseConnector({
      id: "ds_parity",
      name: "Close parity",
      type: "close",
      config: { api_key },
    });
    connector.sleep = async () => {};
    if (baseUrl) {
      const client = createCloseClient({
        apiKey: api_key,
        minDelayMs: 0,
        emitLog: () => {},
        sleep: async () => {},
      });
      client.defaults.baseURL = baseUrl;
      connector.closeApi = client;
    }
    return connector;
  };
}

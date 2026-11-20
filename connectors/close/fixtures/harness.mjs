/**
 * Fixture harness for the Close folder: the replay and recording servers,
 * the Close emulator over `dataset.mjs`, and the runners that drive the
 * folder the way a box does.
 *
 * The folder talks to a local HTTP server through its `__base_url` config
 * key. In replay mode the server answers only requests it has a cassette
 * for; any other request is a miss. `golden.mjs --record` rebuilds the
 * cassettes from the emulator.
 *
 * The clock is frozen at FIXTURE_NOW: the Search API walk ends one day after
 * "now", and its binary-search probes are computed from it. In the folder
 * process `clock.mjs` also shortens timers under 5 s to 0, so the rate-limit
 * pauses and retry waits do not slow the replay.
 *
 * This file has no dependency on the API.
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

/** Close's own Search page. The folder pages by `__page_size` when set. */
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
  // Two rows a page, one page per chunk. The offset lists and Search page
  // by 2 (`__page_size`).
  { name: "small-pages", maxIterations: 1, pageSize: 2 },
  // The engine's default chunk of 10 pages.
  { name: "default", maxIterations: 10 },
  // Incremental: `date_updated` windows from `since`.
  { name: "since", maxIterations: 10, since: SINCE },
];

/** The `_limit` of every Search request in a request log. */
export function searchLimits(requests) {
  return requests
    .filter(key => key.startsWith("POST /data/search/ "))
    .map(key => JSON.parse(key.slice("POST /data/search/ ".length))._limit);
}

/**
 * What the folder reads on purpose that the deleted in-process connector got
 * only from webhooks, so a poll-only connection (the box has no webhooks
 * yet) holds the same data.
 *
 * Per entity: the extra rows (`row`), columns (`columns`), schema fields
 * (`schemaFields`) and requests (`request`):
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
      ) &&
      // Set on deactivated users, null on every other one (an upsert only
      // writes the columns a batch carries, so null clears a stale mark).
      folderRows.every(
        row =>
          "_mako_deleted_at" in row &&
          (row._mako_deleted_at != null) === (row.is_active === false),
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
 * Freeze `Date.now` in this process. Returns the
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

/**
 * Close's Search leaves `source` out of a lead even when `_fields` names it.
 * It answers the smart field `first_source` with the same value.
 */
function searchRow(objectType, row, fields) {
  if (objectType !== "lead") return project(row, fields);
  const { source, ...rest } = row;
  return project({ ...rest, first_source: source }, fields);
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
      data: page.map(row => searchRow(objectType, row, fields)),
      cursor: next
        ? Buffer.from(
            JSON.stringify({ s: signature, o: offset + limit }),
          ).toString("base64url")
        : null,
    },
  };
}

// ---------------------------------------------------------------------------
// Running the folder
// ---------------------------------------------------------------------------

const scratch = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "mako-close-fixture-"));

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

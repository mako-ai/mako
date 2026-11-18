/**
 * Parity harness: the in-process Wise connector and this folder, run
 * against the same recorded Wise responses, compared entity by entity.
 *
 * Both connectors talk to a local HTTP server through `api_base_url`. In
 * replay mode the server answers only requests it has a cassette for, so a
 * folder that sends a different request than the in-process connector fails
 * with a cassette miss, and the request logs are compared as well.
 *
 * The clock is frozen at FIXTURE_NOW on both sides, `new Date()` included:
 * the balance-statement walk ends its last window at "now". In the folder
 * process `clock.mjs` also shortens timers under 5 s to 0, so the pauses
 * between pages and the retry waits do not slow the replay.
 *
 * Strong customer authentication runs for real: the server answers the
 * business profile's statements 403 with an `x-2fa-approval` token, and
 * checks the SHA256withRSA signature each side sends back against a key
 * pair generated per run (`SCA_TEST_KEYS`). No key is stored.
 *
 * For each entity and scenario it compares:
 * - row count, key set and row order;
 * - column set (the union of fields across rows);
 * - a SHA-256 checksum per row, over canonical JSON;
 * - each row's source timestamp, as each connector resolves it;
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
import { FIXTURE_NOW } from "./dataset.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const FOLDER = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(FOLDER, "../..");
export const SDK_DIR = path.join(REPO_ROOT, "packages/connector-sdk");
export const RUNNER = path.join(SDK_DIR, "bin/mako-connector.js");
export const CASSETTE_DIR = path.join(here, "cassettes");
export const CLOCK = path.join(here, "clock.mjs");
export { FIXTURE_NOW };

/** The incremental anchor of the `since` scenario. */
export const SINCE = "2026-08-01T00:00:00.000Z";

export const SCENARIOS = [
  // One page per chunk: every page boundary is a chunk boundary.
  { name: "chunked", maxIterations: 1 },
  // Two rows a page (`batchSize` / `__page_size`), one page per chunk.
  { name: "small-pages", maxIterations: 1, pageSize: 2 },
  // The engine's default chunk of 10 pages.
  { name: "default", maxIterations: 10 },
  // Incremental: `createdDateStart`, `since`, statement windows from `since`.
  { name: "since", maxIterations: 10, since: SINCE },
];

/** A scenario where every request is answered 429 once before it succeeds. */
export const RATE_LIMIT_SCENARIO = {
  name: "rate-limited",
  maxIterations: 10,
  rateLimited: true,
};
export const RATE_LIMIT_ENTITIES = [
  "profiles",
  "transfers",
  "balance_statements",
];

/**
 * The RSA key pair a connection signs SCA challenges with in the fixtures.
 * Generated per run, never stored.
 */
export const SCA_TEST_KEYS = crypto.generateKeyPairSync("rsa", {
  modulusLength: 2048,
  publicKeyEncoding: { type: "spki", format: "pem" },
  privateKeyEncoding: { type: "pkcs8", format: "pem" },
});

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
 * Freeze the clock in this process (the in-process side): `Date.now()` and
 * `new Date()` with no argument. Returns the restore function.
 */
export function freezeClock() {
  const RealDate = globalThis.Date;
  const frozen = Date.parse(FIXTURE_NOW);
  class FixtureDate extends RealDate {
    constructor(...args) {
      if (args.length === 0) super(frozen);
      else super(...args);
    }
    static now() {
      return frozen;
    }
  }
  globalThis.Date = FixtureDate;
  return () => {
    globalThis.Date = RealDate;
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
 * `GET /v1/transfers?limit=100&offset=0&profile=1`: method, path, decoded and
 * sorted query, so encodings and key order agree. A request answering an
 * SCA challenge carries the challenge it answers.
 */
export function requestKey(method, rawUrl, approval) {
  const url = new URL(rawUrl, "http://wise.local");
  const pairs = [...url.searchParams.entries()].sort(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b),
  );
  const query = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  return `${method} ${url.pathname}${query ? `?${query}` : ""}${approval ? ` [x-2fa-approval ${approval}]` : ""}`;
}

function bearer(req) {
  const header = String(req.headers.authorization ?? "");
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

const wiseError = (status, body, headers = {}) => ({ status, body, headers });

/** Every cassette file, merged into one request -> response map. */
export function loadCassettes(dir = CASSETTE_DIR) {
  const interactions = new Map();
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const entries = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const entry of entries) {
      interactions.set(entry.request, {
        status: entry.status,
        headers: entry.headers ?? {},
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
        ...(Object.keys(response.headers ?? {}).length
          ? { headers: response.headers }
          : {}),
        body: response.body,
      }),
    );
    fs.writeFileSync(
      path.join(dir, `${name}.json`),
      `[\n${lines.join(",\n")}\n]\n`,
    );
  }
}

/** The one-time token the server asks a request to sign. */
const challengeFor = key =>
  `ott-${crypto.createHash("sha256").update(key).digest("hex").slice(0, 24)}`;

/** Statements of these profiles need SCA, in both modes. */
const SCA_PATH = /^\/v1\/profiles\/(\d+)\/balance-statements\//;

/**
 * A local Wise. `answer(key, url)` returns `{ status, body, headers? }`.
 *
 * Every request is logged under the bearer token that sent it, which is how
 * concurrent runs keep separate logs. Only `wise_test_` tokens are served:
 * this server must never see a real one. A token containing `_revoked` gets
 * 401. A token containing `_ratelimit` gets one 429 with `Retry-After: 1`
 * for each distinct request before the real answer.
 */
async function startServer(answer, scaProfiles) {
  const log = new Map();
  const limited = new Set();
  const server = http.createServer((req, res) => {
    const method = req.method ?? "GET";
    const rawUrl = req.url ?? "/";
    const approval = req.headers["x-2fa-approval"];
    const key = requestKey(method, rawUrl, approval);
    const token = bearer(req);
    if (!log.has(token)) log.set(token, []);
    log.get(token).push(key);

    let response;
    const pathname = new URL(rawUrl, "http://wise.local").pathname;
    const sca = SCA_PATH.exec(pathname);
    if (!token.startsWith("wise_test_")) {
      response = wiseError(401, {
        error: "unauthorized",
        error_description: "Invalid token",
      });
    } else if (token.includes("_revoked")) {
      response = wiseError(401, {
        error: "invalid_token",
        error_description: "Invalid token",
      });
    } else if (
      token.includes("_ratelimit") &&
      !limited.has(`${token} ${key}`)
    ) {
      limited.add(`${token} ${key}`);
      response = wiseError(
        429,
        { error: "too_many_requests" },
        { "retry-after": "1" },
      );
    } else if (sca && scaProfiles.has(sca[1]) && !approval) {
      response = wiseError(
        403,
        {
          error: "forbidden",
          message: "You are forbidden to access this resource",
        },
        { "x-2fa-approval": challengeFor(key) },
      );
    } else if (sca && scaProfiles.has(sca[1])) {
      const signature = String(req.headers["x-signature"] ?? "");
      const ok =
        approval === challengeFor(requestKey(method, rawUrl)) &&
        crypto
          .createVerify("SHA256")
          .update(String(approval))
          .verify(SCA_TEST_KEYS.publicKey, signature, "base64");
      response = ok
        ? answer(key, rawUrl)
        : wiseError(
            403,
            { error: "forbidden" },
            { "x-2fa-approval-result": "REJECTED" },
          );
    } else {
      response = answer(key, rawUrl);
    }
    res.writeHead(response.status, {
      "content-type": "application/json",
      ...(response.headers ?? {}),
    });
    res.end(JSON.stringify(response.body));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    requests: token => [...(log.get(token) ?? [])],
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

const DEFAULT_SCA_PROFILES = new Set(["22222222"]);

/** Replay: answer from cassettes only. A miss is a 404 the connector sees. */
export async function startReplayServer(interactions = loadCassettes()) {
  const misses = [];
  const server = await startServer(key => {
    const hit = interactions.get(key);
    if (hit) return hit;
    misses.push(key);
    return wiseError(404, {
      error: "not_found",
      message: `No cassette for ${key}`,
    });
  }, DEFAULT_SCA_PROFILES);
  return { ...server, misses };
}

/** Record: answer from the Wise emulator over `dataset`, keep everything. */
export async function startRecordingServer(dataset) {
  const recorded = new Map();
  const server = await startServer((key, url) => {
    const response = emulate(dataset, url);
    recorded.set(key, response);
    return response;
  }, dataset.scaProfiles);
  return { ...server, recorded };
}

// ---------------------------------------------------------------------------
// The Wise emulator: only what the connectors call
// ---------------------------------------------------------------------------

/** A row as Wise serves it: without the dataset's own `__` keys. */
const served = row =>
  Object.fromEntries(Object.entries(row).filter(([k]) => !k.startsWith("__")));

const notFound = () =>
  wiseError(404, { errors: [{ code: "NOT_FOUND", message: "Not found" }] });

/** Wise caps a recipients page at 20, whatever `size` asks for. */
const RECIPIENT_CAP = 20;

export function emulate(dataset, rawUrl) {
  const url = new URL(rawUrl, "http://wise.local");
  const route = url.pathname;
  const q = Object.fromEntries(url.searchParams.entries());
  let m;
  if (dataset.failing?.has(route)) {
    return wiseError(400, {
      errors: [{ code: "error.bad.request", message: "Bad request" }],
    });
  }

  if (route === "/v1/me") return { status: 200, body: dataset.me };
  if (route === "/v2/profiles") {
    return { status: 200, body: dataset.profiles.map(served) };
  }
  if ((m = /^\/v2\/profiles\/(\d+)$/.exec(route))) {
    const profile = dataset.profiles.find(p => String(p.id) === m[1]);
    return profile ? { status: 200, body: served(profile) } : notFound();
  }
  if ((m = /^\/v4\/profiles\/(\d+)\/balances$/.exec(route))) {
    return {
      status: 200,
      body: dataset.balances
        .filter(b => String(b.__profileId) === m[1])
        .map(served),
    };
  }
  if ((m = /^\/v4\/profiles\/(\d+)\/balances\/(\d+)$/.exec(route))) {
    const balance = dataset.balances.find(
      b => String(b.__profileId) === m[1] && String(b.id) === m[2],
    );
    return balance ? { status: 200, body: served(balance) } : notFound();
  }
  if (route === "/v1/transfers") {
    let rows = dataset.transfers.filter(
      t => String(t.__profileId) === q.profile,
    );
    if (q.createdDateStart) {
      rows = rows.filter(t => t.created.slice(0, 10) >= q.createdDateStart);
    }
    rows.sort((a, b) =>
      a.created === b.created ? b.id - a.id : a.created < b.created ? 1 : -1,
    );
    const offset = Number(q.offset ?? 0);
    const limit = Number(q.limit ?? 100);
    return {
      status: 200,
      body: rows.slice(offset, offset + limit).map(served),
    };
  }
  if ((m = /^\/v1\/transfers\/(\d+)$/.exec(route))) {
    const transfer = dataset.transfers.find(t => String(t.id) === m[1]);
    return transfer ? { status: 200, body: served(transfer) } : notFound();
  }
  if (route === "/v2/accounts") {
    const rows = dataset.recipients
      .filter(r => String(r.__profileId) === q.profile)
      .sort((a, b) => a.id - b.id);
    const seek = q.seekPosition;
    const rest = seek ? rows.filter(r => r.id > Number(seek)) : rows;
    const size = Math.min(Number(q.size ?? 20), RECIPIENT_CAP);
    const content = rest.slice(0, size);
    const more = rest.length > size;
    const end = dataset.recipientEnd[q.profile];
    const seekPositionForNext = more
      ? content.at(-1).id
      : content.length === 0
        ? null
        : end === "echo"
          ? seek
            ? Number(seek)
            : null
          : content.at(-1).id;
    return {
      status: 200,
      body: {
        content: content.map(served),
        sortBy: "id",
        size: content.length,
        seekPositionForNext,
      },
    };
  }
  if ((m = /^\/v2\/accounts\/(\d+)$/.exec(route))) {
    const recipient = dataset.recipients.find(r => String(r.id) === m[1]);
    return recipient ? { status: 200, body: served(recipient) } : notFound();
  }
  if ((m = /^\/v1\/profiles\/(\d+)\/activities$/.exec(route))) {
    let rows = dataset.activities
      .filter(a => String(a.__profileId) === m[1])
      .sort((a, b) => (a.createdOn < b.createdOn ? 1 : -1));
    if (q.since) rows = rows.filter(a => a.updatedOn >= q.since);
    const offset = q.nextCursor ? Number(q.nextCursor.split("-").at(-1)) : 0;
    const size = Number(q.size ?? 10);
    const page = rows.slice(offset, offset + size);
    const more = rows.length > offset + size;
    const end = dataset.activityEnd[m[1]];
    const cursor = more
      ? `cur-${m[1]}-${offset + size}`
      : end === "echo"
        ? (q.nextCursor ?? null)
        : null;
    return { status: 200, body: { cursor, activities: page.map(served) } };
  }
  if (
    (m =
      /^\/v1\/profiles\/(\d+)\/balance-statements\/(\d+)\/statement\.json$/.exec(
        route,
      ))
  ) {
    const balance = dataset.balances.find(
      b => String(b.__profileId) === m[1] && String(b.id) === m[2],
    );
    if (!balance) return notFound();
    const start = Date.parse(q.intervalStart);
    const end = Date.parse(q.intervalEnd);
    const transactions = (dataset.statements.get(balance.id) ?? []).filter(
      t => Date.parse(t.date) >= start && Date.parse(t.date) < end,
    );
    return {
      status: 200,
      body: {
        accountHolder: { type: "PERSONAL" },
        issuer: { name: "Wise Europe SA" },
        transactions,
        startOfStatementBalance: money0(balance.currency),
        endOfStatementBalance: money0(balance.currency),
        query: {
          intervalStart: q.intervalStart,
          intervalEnd: q.intervalEnd,
          currency: q.currency,
          accountId: balance.id,
        },
      },
    };
  }
  return notFound();
}

const money0 = currency => ({ value: 0, currency });

// ---------------------------------------------------------------------------
// Running the two connectors
// ---------------------------------------------------------------------------

const scratch = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "mako-wise-parity-"));

/** Run one SDK command on the folder and parse its JSON Lines. */
export function runFolderCommand(
  command,
  { config, catalog, state, maxIterations, maxBytes, batch } = {},
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

/** A state without the incremental anchor: the read position. */
const positionOf = state => {
  if (!state) return {};
  const { since: _since, mako: _mako, ...position } = state;
  return position;
};

/** The in-process `FetchState` as a read position: its metadata. */
export const inProcessPosition = state => state?.metadata ?? {};

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

/**
 * Drive `SandboxedConnector` (the box path, with the box swapped for a local
 * process) chunk by chunk, as the engine does.
 */
export async function readBoxed(
  connector,
  { entity, since, maxIterations, pageSize },
) {
  const rows = [];
  const chunks = [];
  let state;
  for (let chunk = 0; chunk < 2000; chunk++) {
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

/**
 * Drive the in-process connector chunk by chunk, as the engine does, with a
 * fresh connector per chunk (`performSyncChunk` builds one per chunk too, so
 * the profile list is read again exactly as in production).
 */
export async function readInProcess(
  makeConnector,
  { entity, since, maxIterations, pageSize },
) {
  const rows = [];
  const chunks = [];
  let state;
  for (let chunk = 0; chunk < 2000; chunk++) {
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

/** Wise's time fields and the base resolver's, as either side reads them. */
const TIMESTAMP_CANDIDATES = [
  "occurred_at",
  "modificationTime",
  "updatedOn",
  "updatedAt",
  "updated_at",
  "createdOn",
  "createdAt",
  "created_at",
  "creationTime",
  "created",
  "sent_at",
  "date",
  "date_updated",
  "date_modified",
  "date_created",
  "timestamp",
];

/**
 * Whether a row carries a time either resolver can read. A row without one
 * gets "now" from both; it is counted as a fallback, not compared.
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
 * `sourceTs` maps (entity, row) to its resolved source time, per side.
 */
export function compareRuns(inProcess, folder, sourceTs, entity) {
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
      const ta = sourceTs.inProcess(entity, a);
      const tb = sourceTs.folder(entity, b);
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
  };
  result.ok =
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

/** The connection config of one side of one run. */
export function testConfig(token, server, extra = {}) {
  return {
    api_key: token,
    api_base_url: server.url,
    sca_private_key: SCA_TEST_KEYS.privateKey,
    ...extra,
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
  const work = async ({ entity, scenario }) => {
    const options = {
      entity,
      since: scenario.since,
      maxIterations: scenario.maxIterations,
      pageSize: scenario.pageSize,
    };
    const limited = scenario.rateLimited ? "_ratelimit" : "";
    const inKey = `wise_test_inprocess${limited}_${scenario.name}_${entity}`;
    const folderKey = `wise_test_folder${limited}_${scenario.name}_${entity}`;
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
      readInProcess(() => makeInProcess(testConfig(inKey, server)), options),
    );
    inProcess.requests = server.requests(inKey);
    const boxed = makeBoxed?.(testConfig(folderKey, server));
    const folder = await run("folder", () =>
      boxed
        ? readBoxed(boxed, options)
        : readFolder({
            ...options,
            config: testConfig(folderKey, server, {
              ...(scenario.pageSize ? { __page_size: scenario.pageSize } : {}),
              __rate_limit_delay_ms: 1,
            }),
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

/** `check` on both sides, with a working token and a revoked one. */
export async function checkParity({ makeInProcess, server }) {
  const outcomes = [];
  for (const variant of ["valid", "revoked"]) {
    const suffix = variant === "revoked" ? "_revoked" : "";
    const inKey = `wise_test_inprocess_check${suffix}`;
    const folderKey = `wise_test_folder_check${suffix}`;
    const inResult = await makeInProcess(
      testConfig(inKey, server),
    ).testConnection();
    const folderRun = await runFolderCommand("check", {
      config: testConfig(folderKey, server),
    });
    const status = folderRun.messages.find(
      m => m.type === "CONNECTION_STATUS",
    )?.connectionStatus;
    outcomes.push({
      variant,
      inProcess: inResult.success,
      folder: status?.status === "SUCCEEDED",
      inProcessMessage: inResult.details,
      folderMessage: status?.message,
      requestsEqual: sameList(
        server.requests(inKey),
        server.requests(folderKey),
      ),
      requests: server.requests(inKey).length,
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
 * out of the field lists.
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
    canonicalJson(inProcess?.keyColumns ?? ["id"]) ===
    canonicalJson(folder?.keyColumns);
  const policy = inProcess?.unknownFieldPolicy === folder?.unknownFieldPolicy;
  return {
    fields: [inNames.length, folderNames.length],
    missing,
    extra,
    fieldDiffs,
    keyColumns,
    policy,
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
    rows: field.rows,
    required: Boolean(field.required),
    default: field.default,
    helperText: field.helperText,
    encrypted: Boolean(field.encrypted || field.type === "password"),
  });
  const a = inProcessFields.map(shape);
  const b = folderFields.map(shape);
  return { ok: canonicalJson(a) === canonicalJson(b), inProcess: a, folder: b };
}

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** Run the folder's in-process webhook half on a batch, in its own process. */
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
  // In-process stores the event its own check made of the delivery.
  return events.map(
    ({ eventId, eventType, rawPayload: stored, inProcessPayload }) => {
      const rawPayload = inProcessPayload ?? stored;
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
    },
  );
}

/**
 * Webhook parity: the subscribed events, the events per entity, the
 * signature checks (`inProcessVerify(delivery)` against the folder's port,
 * both with `publicKeys`) and the change records of every event.
 */
export async function webhookParity({
  connector,
  events,
  deliveries,
  publicKeys,
  inProcessVerify,
}) {
  const entitySets = [
    [],
    ["transfers"],
    ["balance_updates", "balances"],
    ["profiles", "recipients"],
    ["activities"],
  ];
  const folder = await runFolderWebhook({
    verify: deliveries.map(({ payload, headers, secret }) => ({
      payload,
      headers,
      secret,
    })),
    publicKeys,
    entitySets,
    events,
  });
  const inEvents = connector.getSupportedWebhookEvents();
  const verify = deliveries.map((delivery, i) => {
    const inResult = inProcessVerify(delivery);
    return {
      name: delivery.name,
      inProcess: inResult.valid,
      folder: folder.verify[i].valid,
      same: canonicalJson(inResult) === canonicalJson(folder.verify[i]),
    };
  });
  const forEntities = entitySets.map((entities, i) => ({
    entities,
    same: sameList(
      connector.getWebhookEventsForEntities(entities),
      folder.eventsForEntities[i],
    ),
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
    forEntities,
    verify,
    outcomes,
    ok:
      sameList(inEvents, folder.events) &&
      forEntities.every(f => f.same) &&
      verify.every(v => v.same) &&
      outcomes.every(o => o.same),
  };
}

/**
 * A factory of in-process connectors on `config` (its `api_base_url` points
 * at the fixture server). Waits are stubbed; the request sequence is not.
 */
export function inProcessFactory({ WiseConnector }) {
  return config => {
    const connector = new WiseConnector({
      id: "ds_parity",
      name: "Wise parity",
      type: "wise",
      config,
    });
    connector.sleep = async () => {};
    return connector;
  };
}

/**
 * Harness for the Calendly folder: a replay and a recording server for the
 * Calendly API, and the helpers that run the folder's commands against them.
 * The in-process connector this folder was ported from is deleted, so the
 * folder is held to its own golden files (`golden.mjs`).
 *
 * The folder talks to a local HTTP server through `api_base_url`. In replay
 * mode the server answers only requests it has a cassette for, so a request
 * the folder did not send when the cassettes were recorded fails the read
 * with a cassette miss.
 *
 * Calendly returns absolute URIs, and the folder calls those URIs back.
 * Cassettes hold them under the placeholder host `BASE` (dataset.mjs): the
 * server swaps it for its own URL in every answer, and back in every
 * request key.
 *
 * In the folder process `clock.mjs` shortens timers under 5 s to 0, so the
 * pauses and `Retry-After: 1` retries do not slow the replay.
 *
 * This file has no dependency on the API.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { BASE } from "./dataset.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const FOLDER = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(FOLDER, "../..");
export const SDK_DIR = path.join(REPO_ROOT, "packages/connector-sdk");
export const RUNNER = path.join(SDK_DIR, "bin/mako-connector.js");
export const CASSETTE_DIR = path.join(here, "cassettes");
export const CLOCK = path.join(here, "clock.mjs");

/** The incremental anchor of the `since` scenario. */
export const SINCE = "2026-08-01T00:00:00.000Z";

export const SCENARIOS = [
  // One page per chunk: every page boundary is a chunk boundary; invitees
  // stop after every events page and every wave.
  { name: "chunked", maxIterations: 1 },
  // Two rows a page (`count=2`), one page per chunk. Invitee pages are 2
  // rows too; the events page stays 100.
  { name: "small-pages", maxIterations: 1, pageSize: 2 },
  // The engine's default chunk of 10 pages.
  { name: "default", maxIterations: 10 },
  // Incremental: `min_start_time` for events and invitees, `updated_at`
  // filtered here for the rest.
  { name: "since", maxIterations: 10, since: SINCE },
];

/** Every request is answered 429 once before it succeeds. */
export const RATE_LIMIT_SCENARIO = {
  name: "rate-limited",
  maxIterations: 10,
  rateLimited: true,
};
export const RATE_LIMIT_ENTITIES = ["users", "scheduled_events", "invitees"];

/** Entities whose requests are compared as a sorted list (see above). */
export const CONCURRENT_ENTITIES = new Set(["invitees"]);

/** Environment for a folder process: short timers. */
export function folderEnv() {
  const preload = `--import ${pathToFileURL(CLOCK).href}`;
  return {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" "),
    MAKO_FIXTURE_FAST_TIMERS: "1",
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
 * `GET /x?b=2&a=1` -> `GET /x?a=1&b=2`, decoded, with the server's own URL
 * written back as `BASE`, so encodings and ports agree.
 */
export function requestKey(method, rawUrl, serverUrl) {
  const url = new URL(rawUrl, "http://calendly.local");
  const pairs = [...url.searchParams.entries()]
    .map(([key, value]) => [key, value.split(serverUrl).join(BASE)])
    .sort(([a, av], [b, bv]) =>
      a === b ? av.localeCompare(bv) : a.localeCompare(b),
    );
  const query = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  return `${method} ${url.pathname}${query ? `?${query}` : ""}`;
}

function bearer(req) {
  const header = String(req.headers.authorization ?? "");
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

const calendlyError = (status, title, message) => ({
  status,
  body: { title, message },
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
    const lines = [...interactions]
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([request, response]) =>
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
 * A local Calendly. `answer(key, url)` returns `{ status, body }` with URIs
 * under `BASE`; the server writes its own URL in their place.
 *
 * Every request is logged under the token that sent it, which is how
 * concurrent runs keep separate logs. Only `cal_test_` tokens are served:
 * this server must never see a real token. A token containing `_revoked`
 * gets 401. A token containing `_ratelimit` gets one 429 with
 * `Retry-After: 1` for each distinct request before the real answer, so
 * the folder's retry policy runs.
 */
async function startServer(answer) {
  const log = new Map();
  const limited = new Set();
  let serverUrl = "";
  const server = http.createServer((req, res) => {
    const key = requestKey(req.method ?? "GET", req.url ?? "/", serverUrl);
    const token = bearer(req);
    if (!log.has(token)) log.set(token, []);
    log.get(token).push(key);

    let response;
    let headers = {};
    if (!token.startsWith("cal_test_")) {
      response = calendlyError(
        401,
        "Unauthenticated",
        "The access token is invalid",
      );
    } else if (token.includes("_revoked")) {
      response = calendlyError(
        401,
        "Unauthenticated",
        "The access token is revoked",
      );
    } else if (
      token.includes("_ratelimit") &&
      !limited.has(`${token} ${key}`)
    ) {
      limited.add(`${token} ${key}`);
      response = calendlyError(429, "Too Many Requests", "Rate limit exceeded");
      headers = { "retry-after": "1" };
    } else {
      response = answer(key, req.url ?? "/");
    }
    res.writeHead(response.status, {
      "content-type": "application/json",
      ...headers,
    });
    res.end(JSON.stringify(response.body).split(BASE).join(serverUrl));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  serverUrl = `http://127.0.0.1:${port}`;
  return {
    url: serverUrl,
    requests: token => [...(log.get(token) ?? [])],
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
    return calendlyError(404, "Resource Not Found", `No cassette for ${key}`);
  });
  return { ...server, misses };
}

/** Record: answer from the Calendly emulator over `dataset`, keep everything. */
export async function startRecordingServer(dataset) {
  const recorded = new Map();
  const server = await startServer((key, url) => {
    const response = emulate(dataset, url);
    recorded.set(key, response);
    return response;
  });
  return { ...server, recorded };
}

// ---------------------------------------------------------------------------
// The Calendly emulator: only what the connectors call
// ---------------------------------------------------------------------------

const TOKEN = /^o:(\d+)$/;

function emulate(dataset, rawUrl) {
  const url = new URL(rawUrl, "http://calendly.local");
  const route = url.pathname;
  const query = Object.fromEntries(url.searchParams.entries());
  // Calendly echoes the configured host; the emulator speaks in `BASE`.
  const org = query.organization?.replace(/^https?:\/\/[^/]+/, BASE);

  if (route === "/users/me") return { status: 200, body: dataset.me };
  if (`${BASE}${route}` === dataset.organization.uri) {
    return { status: 200, body: { resource: dataset.organization } };
  }

  const invitees = /^\/scheduled_events\/([^/]+)\/invitees$/.exec(route);
  if (invitees) {
    if (invitees[1] === dataset.goneEvent) {
      return calendlyError(404, "Resource Not Found", "The event is gone");
    }
    const rows = dataset.invitees.get(invitees[1]);
    if (!rows) return calendlyError(404, "Resource Not Found", "No such event");
    return listPage(rows, query);
  }

  const single = /^\/(scheduled_events|event_types)\/([^/]+)$/.exec(route);
  if (single) {
    const uri = `${BASE}${route}`;
    const row = dataset.lists[`/${single[1]}`].find(r => r.uri === uri);
    if (!row) return calendlyError(404, "Resource Not Found", "Not found");
    return { status: 200, body: { resource: row } };
  }

  let rows = dataset.lists[route];
  if (!rows)
    return calendlyError(404, "Resource Not Found", `No route ${route}`);
  if (route !== "/contacts" && org !== dataset.organization.uri) {
    return calendlyError(400, "Invalid Argument", "organization is required");
  }
  if (route === "/scheduled_events") {
    if (query.sort !== "start_time:asc") {
      return calendlyError(400, "Invalid Argument", "sort must be start_time");
    }
    rows = [...rows].sort(
      (a, b) =>
        a.start_time.localeCompare(b.start_time) || a.uri.localeCompare(b.uri),
    );
    if (query.min_start_time) {
      const min = Date.parse(query.min_start_time);
      rows = rows.filter(r => Date.parse(r.start_time) >= min);
    }
  } else if (route === "/event_types" && query.sort === "name:asc") {
    rows = [...rows].sort((a, b) => a.name.localeCompare(b.name));
  }
  return listPage(rows, query);
}

function listPage(rows, query) {
  const count = Number(query.count ?? 20);
  if (!Number.isInteger(count) || count < 1 || count > 100) {
    return calendlyError(400, "Invalid Argument", "count must be 1 to 100");
  }
  let offset = 0;
  if (query.page_token) {
    const m = TOKEN.exec(query.page_token);
    if (!m) return calendlyError(400, "Invalid Argument", "bad page_token");
    offset = Number(m[1]);
  }
  const page = rows.slice(offset, offset + count);
  const next = offset + count < rows.length ? `o:${offset + count}` : null;
  return {
    status: 200,
    body: {
      collection: page,
      pagination: { count: page.length, next_page_token: next },
    },
  };
}

// ---------------------------------------------------------------------------
// Running the folder
// ---------------------------------------------------------------------------

const scratch = () => fs.mkdtempSync(path.join(os.tmpdir(), "mako-calendly-"));

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

/** The read position of a folder state, without the incremental anchor. */
const positionOf = state => {
  if (!state) return {};
  const { since: _since, mako: _mako, ...position } = state;
  return position;
};

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

// ---------------------------------------------------------------------------
// Webhooks
// ---------------------------------------------------------------------------

/** The folder's mapping (before any fill) of a batch, in its own process. */
export function runFolderWebhookMapping(input) {
  const dir = scratch();
  const file = path.join(dir, "input.json");
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

/** The token of one golden read: a test token per scenario and entity. */
export const tokenFor = (prefix, scenario, entity) =>
  `cal_test_${prefix}${scenario.rateLimited ? "_ratelimit" : ""}_${scenario.name}_${entity}`;

/** The config of one scenario's read, against a fixture server. */
export const scenarioConfig = (token, server, scenario) => ({
  access_token: token,
  api_base_url: server.url,
  ...(scenario.pageSize ? { __page_size: scenario.pageSize } : {}),
});

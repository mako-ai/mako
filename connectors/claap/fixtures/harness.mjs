/**
 * Fixture harness for the Claap folder: the replay and recording servers,
 * the Claap emulator over `dataset.mjs` and the runners that drive the
 * folder the way a box does.
 *
 * The folder talks to a local HTTP server through `api_base_url`. In replay
 * mode the server answers only requests it has a cassette for; any other
 * request is a miss. Signed transcript links go to the same server, tagged
 * with the run's key. `golden.mjs --record` rebuilds the cassettes from the
 * emulator.
 *
 * `fetchedAt` is the time a transcript was downloaded: `masked` turns it
 * into `<fetchedAt>` so a golden file holds no clock.
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
import {
  SIGNED_ORIGIN,
  buildDataset,
  emulate,
  emulateSigned,
} from "./dataset.mjs";

const here = path.dirname(fileURLToPath(import.meta.url));

export const SLUG = "claap";
export const FOLDER = path.resolve(here, "..");
export const REPO_ROOT = path.resolve(FOLDER, "../..");
export const SDK_DIR = path.join(REPO_ROOT, "packages/connector-sdk");
export const RUNNER = path.join(SDK_DIR, "bin/mako-connector.js");
export const CASSETTE_DIR = path.join(here, "cassettes");
export const CLOCK = path.join(here, "clock.mjs");

export const FIXTURE_NOW = "2026-11-16T12:00:00.000Z";
/** The incremental anchor of the `since` scenario. */
export const SINCE = "2026-09-01T00:00:00.000Z";

export const ENTITIES = ["recordings", "recording_transcripts", "workspace"];

export const SCENARIOS = [
  // Two recordings a page, one page per chunk (transcript pages stay at 50).
  { name: "chunked", maxIterations: 1, pageSize: 2 },
  // The engine's defaults: 100 rows asked, 50 read, 10 pages a chunk.
  { name: "default", maxIterations: 10 },
  // Incremental from SINCE: `createdAfter`, minus 2 days for transcripts.
  { name: "since", maxIterations: 10, pageSize: 5, since: SINCE },
  // `recordings_lookback_days: 3` moves the recordings anchor back.
  {
    name: "lookback",
    maxIterations: 10,
    pageSize: 5,
    since: SINCE,
    config: { recordings_lookback_days: 3 },
  },
];

/** Every request answered 429 once (Retry-After: 1) before it succeeds. */
export const RATE_LIMIT_SCENARIO = {
  name: "rate-limited",
  maxIterations: 10,
  pageSize: 5,
  rateLimited: true,
};
export const RATE_LIMIT_ENTITIES = ["recordings", "workspace"];

/**
 * The daily quota runs low: the fixture answers 520 minus the requests the
 * key sent so far. Recordings checkpoint mid-page, then the next chunk
 * fails before any detail read. The folder stops at the same row,
 * state and request on every run, with the daily-quota error. (Transcript pages are 50 rows
 * and the dataset is 23 recordings, so their quota check never trips here.)
 */
export const QUOTA_SCENARIO = {
  name: "quota",
  maxIterations: 10,
  pageSize: 10,
  quota: true,
};
export const QUOTA_START = 520;

/** Environment for a folder process: frozen clock, short timers. */
export function folderEnv(config) {
  const preload = `--import ${pathToFileURL(CLOCK).href}`;
  const base =
    typeof config?.api_base_url === "string" ? config.api_base_url : "";
  return {
    ...process.env,
    NODE_OPTIONS: [process.env.NODE_OPTIONS, preload].filter(Boolean).join(" "),
    MAKO_FIXTURE_NOW: FIXTURE_NOW,
    MAKO_FIXTURE_FAST_TIMERS: "1",
    // Signed links point at signed.claap.test; the preload sends them to the
    // fixture server, tagged with the run's key so each run's log is its own.
    ...(base
      ? {
          MAKO_FIXTURE_SIGNED_FROM: SIGNED_ORIGIN,
          MAKO_FIXTURE_SIGNED_TO: `${base}/signed`,
          MAKO_FIXTURE_KEY: String(config.api_key ?? ""),
        }
      : {}),
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

/** The key a request carries: `X-Claap-Key`, or the fixture tag on a signed link. */
function apiKeyOf(req) {
  return String(
    req.headers["x-claap-key"] ?? req.headers["x-fixture-key"] ?? "",
  );
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
      .replace(/^\/v1\//, "")
      .replace(/^recordings\/[^/]+\/transcript$/, "transcripts")
      .replace(/^recordings\/[^/]+$/, "recording_details")
      .replace(/^signed\/.*$/, "signed");
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
 * A local Claap. Every request is logged under the key that sent it,
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
      if (apiKey.includes("_quota") && !key.startsWith("GET /signed/")) {
        headers["x-ratelimit-daily-remaining"] = String(
          QUOTA_START - log.get(apiKey).length,
        );
      }
      if (!apiKey.startsWith("api_test_")) {
        response = {
          status: 401,
          body: { error: { message: "Unauthorized" } },
        };
      } else if (apiKey.includes("_revoked")) {
        response = {
          status: 401,
          body: { error: { message: "Invalid API key" } },
        };
      } else if (
        apiKey.includes("_ratelimit") &&
        !limited.has(`${apiKey} ${key}`)
      ) {
        limited.add(`${apiKey} ${key}`);
        response = {
          status: 429,
          body: { error: { message: "Too many requests" } },
        };
        headers["retry-after"] = "1";
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
  // Node closes an idle keep-alive socket after 5 s. A loaded machine can
  // leave a folder's socket idle that long, and its next request then meets
  // a reset and is retried: one request more than the cassettes hold, by accident.
  server.keepAliveTimeout = 120_000;
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
    return {
      status: 404,
      body: { error: { message: `No cassette for ${key}` } },
    };
  });
  return { ...server, misses };
}

/** Record: answer from the emulator over `dataset`, keep every interaction. */
export async function startRecordingServer(dataset = buildDataset()) {
  const recorded = new Map();
  const server = await startServer((key, method, url) => {
    const response = url.startsWith("/signed/")
      ? emulateSigned(dataset, url)
      : emulate(dataset, method, url);
    recorded.set(key, response);
    return response;
  });
  return { ...server, recorded, dataset };
}

// ---------------------------------------------------------------------------
// Running the folder
// ---------------------------------------------------------------------------

const scratch = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), `mako-${SLUG}-fixture-`));

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
      env: folderEnv(config),
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

/** Drive the folder chunk by chunk, as `SandboxedConnector` does. */
export async function readFolder(
  { entity, config, since, maxIterations },
  out = { rows: [], chunks: [] },
) {
  const { rows, chunks } = out;
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

// ---------------------------------------------------------------------------
// Comparison
// ---------------------------------------------------------------------------

/**
 * A row with its download time masked: `fetchedAt` is the clock of the run.
 * Anything but an ISO time stays as it is, and fails the comparison.
 */
export function masked(row) {
  if (!row || typeof row !== "object" || !("fetchedAt" in row)) return row;
  const value = row.fetchedAt;
  const isTime =
    typeof value === "string" &&
    /^\d{4}-\d{2}-\d{2}T/.test(value) &&
    !Number.isNaN(Date.parse(value));
  return isTime ? { ...row, fetchedAt: "<fetchedAt>" } : row;
}

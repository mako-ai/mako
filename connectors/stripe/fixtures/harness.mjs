/**
 * Parity harness: the in-process Stripe connector and this folder, run
 * against the same recorded Stripe responses, compared entity by entity.
 *
 * Both connectors talk to a local HTTP server through `api_base_url`, with the
 * real `stripe` npm package on each side. In replay mode the server answers
 * only requests it has a cassette for, so a folder that sends a different
 * request than the in-process connector fails with a cassette miss, and the
 * request logs are compared as well.
 *
 * For each entity and scenario it compares:
 * - row count, key set and row order;
 * - column set (the union of fields across rows);
 * - a SHA-256 checksum per row, over canonical JSON;
 * - the chunk sequence: cursor and hasMore after every chunk;
 * - the exact request sequence each connector sent;
 * - each row's source timestamp, as each connector resolves it.
 *
 * The folder side runs one of two ways. Given `makeBoxed`, it runs through
 * the API's `SandboxedConnector`, the adapter a box uses, with only the box
 * itself replaced by a local process: `since`, settings, chunk state and the
 * source timestamp all go through the real box path. Without it, the SDK
 * runner is driven directly (`readFolder`), as `parity.mjs` does.
 *
 * This file has no dependency on the API. The caller passes the in-process
 * connector in (see `parity.mjs` and the API test that imports this file).
 */
import { spawn, spawnSync } from "node:child_process";
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

/** The incremental anchor the `since` scenario uses. */
export const SINCE = "2026-01-01T00:00:00.000Z";

export const SCENARIOS = [
  // One page per chunk, at the default page size of 100: the boundaries of
  // the lists longer than one page (customers, payouts, the nested two).
  { name: "chunked", maxIterations: 1 },
  // Two rows per page, one page per chunk: every entity with 3 rows or more
  // resumes from a cursor at least once.
  { name: "small-pages", maxIterations: 1, pageSize: 2 },
  // The engine's default chunk of 10 pages.
  { name: "default", maxIterations: 10 },
  // Incremental: `created[gte]` from `since`.
  { name: "since", maxIterations: 10, since: SINCE },
];

/**
 * Make the folder runnable the way a box would: its own dependencies from its
 * own lockfile, and the SDK provided by the runtime (here, the repo's copy).
 */
export function ensureFolderInstalled() {
  const stripePackage = path.join(FOLDER, "node_modules/stripe/package.json");
  if (!fs.existsSync(stripePackage)) {
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

/** `GET /v1/x?b=2&a=1` -> `GET /v1/x?a=1&b=2`, decoded, so encodings agree. */
export function requestKey(method, rawUrl) {
  const url = new URL(rawUrl, "http://stripe.local");
  const pairs = [...url.searchParams.entries()].sort(([a, av], [b, bv]) =>
    a === b ? av.localeCompare(bv) : a.localeCompare(b),
  );
  const query = pairs.map(([key, value]) => `${key}=${value}`).join("&");
  return `${method} ${url.pathname}${query ? `?${query}` : ""}`;
}

function bearer(req) {
  const header = String(req.headers.authorization ?? "");
  return header.startsWith("Bearer ") ? header.slice(7) : "";
}

const stripeError = (status, type, message) => ({
  status,
  body: { error: { type, message } },
});

/** Every cassette file, merged into one request -> response map. */
export function loadCassettes(dir = CASSETTE_DIR) {
  const interactions = new Map();
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json"))) {
    const entries = JSON.parse(fs.readFileSync(path.join(dir, file), "utf8"));
    for (const entry of entries) {
      interactions.set(entry.request, {
        status: entry.status,
        stripeVersion: entry.stripeVersion,
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
        stripeVersion: response.stripeVersion,
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
 * A local Stripe. `answer(key, req, version)` returns `{ status, body }`.
 *
 * Every request is logged under the API key that sent it, which is how
 * concurrent runs keep separate logs, together with the `Stripe-Version`
 * header it carried: the version decides the shape of every record, so two
 * connectors asking for different versions are sending different requests.
 * A live key is refused before anything else happens: this server must never
 * see one.
 */
async function startServer(answer) {
  const log = new Map();
  const server = http.createServer((req, res) => {
    const key = requestKey(req.method ?? "GET", req.url ?? "/");
    const version = String(req.headers["stripe-version"] ?? "none");
    const apiKey = bearer(req);
    if (!log.has(apiKey)) log.set(apiKey, []);
    log.get(apiKey).push({ key, version });

    let response;
    if (/^(sk|rk)_live_/.test(apiKey)) {
      response = stripeError(
        401,
        "invalid_request_error",
        "Live keys are refused by the fixture server.",
      );
    } else if (!apiKey.startsWith("sk_test_")) {
      response = stripeError(
        401,
        "invalid_request_error",
        "Invalid API Key provided.",
      );
    } else if (apiKey.includes("_revoked")) {
      response = stripeError(
        401,
        "invalid_request_error",
        "Expired API Key provided: sk_test_***revoked",
      );
    } else {
      response = answer(key, req, version);
    }
    res.writeHead(response.status, {
      "content-type": "application/json",
      "request-id": `req_fixture_${log.get(apiKey).length}`,
    });
    res.end(JSON.stringify(response.body));
  });
  await new Promise(resolve => server.listen(0, "127.0.0.1", resolve));
  const { port } = server.address();
  return {
    url: `http://127.0.0.1:${port}`,
    /** `GET /v1/x?limit=100 (Stripe-Version 2023-10-16)`, in order. */
    requests: apiKey =>
      (log.get(apiKey) ?? []).map(
        ({ key, version }) => `${key} (Stripe-Version ${version})`,
      ),
    /** The bare request keys, as cassettes store them. */
    requestKeys: apiKey => (log.get(apiKey) ?? []).map(({ key }) => key),
    close: () => new Promise(resolve => server.close(resolve)),
  };
}

/**
 * Replay: answer from cassettes only. A miss is a 404 the connector sees, and
 * so is a request whose `Stripe-Version` differs from the recorded one.
 */
export async function startReplayServer(interactions = loadCassettes()) {
  const misses = [];
  const server = await startServer((key, _req, version) => {
    const hit = interactions.get(key);
    if (hit && hit.stripeVersion === version) return hit;
    const miss = hit
      ? `${key} with Stripe-Version ${version}, recorded with ${hit.stripeVersion}`
      : key;
    misses.push(miss);
    return stripeError(404, "invalid_request_error", `No cassette for ${miss}`);
  });
  return { ...server, misses };
}

/**
 * Record: answer from an emulated Stripe over `dataset`, and keep every
 * interaction. Implements only what the connectors call: list endpoints with
 * `limit`, `starting_after`, `created[gte]`, `status`, `payout`, the
 * per-customer balance transactions and payment methods, an invoice's lines,
 * a subscription's items, and the account.
 */
export async function startRecordingServer(dataset) {
  const recorded = new Map();
  const server = await startServer((key, req, version) => {
    const response = emulate(dataset, req.url ?? "/");
    recorded.set(key, { ...response, stripeVersion: version });
    return response;
  });
  return { ...server, recorded };
}

function emulate(dataset, rawUrl) {
  const url = new URL(rawUrl, "http://stripe.local");
  const query = Object.fromEntries(url.searchParams.entries());
  const route = url.pathname.replace(/^\/v1\//, "");

  if (route === "account") return { status: 200, body: dataset.account };

  const customerBalance = /^customers\/([^/]+)\/balance_transactions$/.exec(
    route,
  );
  if (customerBalance) {
    const items = dataset.customerBalance.get(customerBalance[1]);
    if (!items)
      return stripeError(404, "invalid_request_error", "No such customer");
    return listPage(items, query, url.pathname);
  }

  const paymentMethods = /^customers\/([^/]+)\/payment_methods$/.exec(route);
  if (paymentMethods) {
    const items = dataset.paymentMethods.get(paymentMethods[1]);
    if (!items)
      return stripeError(404, "invalid_request_error", "No such customer");
    return listPage(items, query, url.pathname);
  }

  const invoiceLines = /^invoices\/([^/]+)\/lines$/.exec(route);
  if (invoiceLines) {
    const items = dataset.invoiceLines.get(invoiceLines[1]);
    if (!items)
      return stripeError(404, "invalid_request_error", "No such invoice");
    return listPage(items, query, url.pathname);
  }

  if (route === "subscription_items" && query.subscription) {
    const items = dataset.subscriptionItems.get(query.subscription);
    if (!items)
      return stripeError(404, "invalid_request_error", "No such subscription");
    return listPage(items, query, url.pathname);
  }

  if (route === "balance_transactions" && query.payout) {
    const items = dataset.payoutTransactions.get(query.payout);
    if (!items)
      return stripeError(404, "invalid_request_error", "No such payout");
    return listPage(items, query, url.pathname);
  }

  let items = dataset.lists[route];
  if (!items)
    return stripeError(
      404,
      "invalid_request_error",
      `Unrecognized request URL (GET: ${url.pathname})`,
    );
  if (route === "subscriptions" && query.status !== "all") {
    // Stripe's own default: canceled and expired subscriptions are hidden.
    items = items.filter(
      s => s.status !== "canceled" && s.status !== "incomplete_expired",
    );
  }
  return listPage(items, query, url.pathname);
}

function listPage(items, query, pathname) {
  // Newest first, as Stripe lists; an invoice's lines have no `created`
  // and keep their invoice order.
  let list = items.every(item => typeof item.created === "number")
    ? [...items].sort((a, b) => b.created - a.created || (a.id < b.id ? 1 : -1))
    : [...items];
  const gte = query["created[gte]"];
  if (gte !== undefined)
    list = list.filter(item => item.created >= Number(gte));
  if (query.starting_after) {
    const index = list.findIndex(item => item.id === query.starting_after);
    if (index === -1) {
      return stripeError(
        400,
        "invalid_request_error",
        `No such object: '${query.starting_after}'`,
      );
    }
    list = list.slice(index + 1);
  }
  const limit = Number(query.limit ?? 10);
  return {
    status: 200,
    body: {
      object: "list",
      data: list.slice(0, limit),
      has_more: list.length > limit,
      url: pathname,
    },
  };
}

// ---------------------------------------------------------------------------
// Running the two connectors
// ---------------------------------------------------------------------------

const scratch = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "mako-stripe-parity-"));

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
    chunks.push({
      cursor: stateMessage?.stream?.stream_state?.cursor,
      hasMore,
    });
    if (!hasMore) break;
    state = [stateMessage];
  }
  return { rows, chunks };
}

/**
 * Drive a connector chunk by chunk, as the engine does: its schema first
 * (the engine resolves it before the first chunk), then `fetchEntityChunk`
 * until `hasMore` is false. Works for the in-process connector and for
 * `SandboxedConnector`, whose cursor lives in its STATE message.
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
    chunks.push({
      cursor: state.cursor ?? state.metadata?.stream?.stream_state?.cursor,
      hasMore: state.hasMore,
    });
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
    const iso = ts instanceof Date ? ts.toISOString() : null;
    if (!iso || Math.abs(ts.getTime() - now) < 60_000) fellBackToNow++;
    byId.set(String(row.id), iso);
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

/**
 * Checksum of a row as it lands: through JSON first, so a value with a
 * `toJSON` (the SDK's `Decimal` for `*_decimal` fields) counts as the string
 * it serializes to, on both sides.
 */
export const rowChecksum = row =>
  crypto
    .createHash("sha256")
    .update(canonicalJson(JSON.parse(JSON.stringify(row))))
    .digest("hex");

const columnsOf = rows =>
  [...new Set(rows.flatMap(row => Object.keys(row)))].sort();
const sameList = (a, b) =>
  a.length === b.length && a.every((value, i) => value === b[i]);

/** Every comparison for one entity and scenario. `ok` is the conjunction. */
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
    result.requestsEqual &&
    result.timestampMismatches.length === 0;
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
    const inKey = `sk_test_inprocess_${scenario.name}_${entity}`;
    const folderKey = `sk_test_folder_${scenario.name}_${entity}`;
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
    const inConnector = makeInProcess({
      api_key: inKey,
      api_base_url: server.url,
    });
    const inProcess = await run("in-process", () =>
      readInProcess(inConnector, options),
    );
    inProcess.requests = server.requests(inKey);
    let folder;
    if (makeBoxed) {
      // The box path: SandboxedConnector turns `since`, the page size and the
      // rate limit into the folder's state and config itself.
      const boxed = makeBoxed({ api_key: folderKey, api_base_url: server.url });
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
            api_key: folderKey,
            api_base_url: server.url,
            ...(scenario.pageSize ? { __page_size: scenario.pageSize } : {}),
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

/** `check` on both sides, with a working key and a revoked one. */
export async function checkParity({ makeInProcess, server }) {
  const outcomes = [];
  for (const variant of ["valid", "revoked"]) {
    const suffix = variant === "revoked" ? "_revoked" : "";
    const inKey = `sk_test_inprocess_check${suffix}`;
    const folderKey = `sk_test_folder_check${suffix}`;
    const inResult = await makeInProcess({
      api_key: inKey,
      api_base_url: server.url,
    }).testConnection();
    const folderRun = await runFolderCommand("check", {
      config: { api_key: folderKey, api_base_url: server.url },
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
      const problems = [];
      if (!r.keys) problems.push("keys");
      if (!r.order) problems.push("order");
      if (!r.columns) problems.push("columns");
      if (r.checksumMismatches.length)
        problems.push(`${r.checksumMismatches.length} checksums`);
      if (!r.chunkStates) problems.push("chunk states");
      if (!r.requestsEqual) problems.push("requests");
      if (r.timestampMismatches?.length)
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

// ---------------------------------------------------------------------------
// Schemas and the credential form
// ---------------------------------------------------------------------------

/**
 * The in-process `ConnectorEntitySchema` against the folder's stream as the
 * engine translates it. Fields in `ignore` (Mako's system columns) are left
 * out: the in-process schema declares them, the folder does not.
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
  // The ignored (system) columns, compared in full: type, nullability,
  // default and derivation must be the same on both sides.
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
  });
  const a = inProcessFields.map(shape);
  const b = folderFields.map(shape);
  return { ok: canonicalJson(a) === canonicalJson(b), inProcess: a, folder: b };
}

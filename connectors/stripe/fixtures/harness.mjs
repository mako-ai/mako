/**
 * Fixture harness for the Stripe folder: a local Stripe that replays the
 * recorded cassettes or emulates `dataset.mjs` while recording, and drivers
 * that run the folder chunk by chunk.
 *
 * The folder talks to the local server through `api_base_url`, with the
 * real `stripe` npm package. In replay mode the server answers only requests
 * it has a cassette for, so a request the folder did not send when the
 * cassettes were recorded fails with a cassette miss.
 *
 * The folder runs one of two ways. `readFolder` drives the SDK runner
 * directly, as `golden.mjs` does. `readBoxed` drives the API's
 * `SandboxedConnector`, the adapter a box uses, with only the box itself
 * replaced by a local process: `since`, settings, chunk state and the source
 * timestamp all go through the real box path.
 *
 * This file has no dependency on the API. The API tests import it
 * (`api/src/connectors/stripe-folder.test.ts`).
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
// Running the folder
// ---------------------------------------------------------------------------

const scratch = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), "mako-stripe-fixtures-"));

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
 * Drive `SandboxedConnector` chunk by chunk, as the engine does: its schema
 * first (the engine resolves it before the first chunk), then
 * `fetchEntityChunk` until `hasMore` is false. The cursor lives in its STATE
 * message.
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
      // Truthy, so the 200 ms default does not slow the replay.
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
// Canonical rows
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
 * it serializes to.
 */
export const rowChecksum = row =>
  crypto
    .createHash("sha256")
    .update(canonicalJson(JSON.parse(JSON.stringify(row))))
    .digest("hex");

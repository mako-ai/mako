import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { bindingFingerprint, makoData, resolveMakoContext } from "./vite.js";

function repo() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "mako-sdk-test-"));
  fs.mkdirSync(path.join(root, ".mako"));
  fs.writeFileSync(
    path.join(root, ".mako", "workspace.json"),
    JSON.stringify({ workspaceId: "ws1", templateVersion: 1 }),
  );
  fs.writeFileSync(path.join(root, ".env"), "MAKO_API_URL=https://api.test/\nMAKO_API_KEY='k-1'\n# c\n");
  const app = path.join(root, "apps", "my-app");
  fs.mkdirSync(path.join(app, "bindings"), { recursive: true });
  fs.writeFileSync(path.join(app, "bindings", "sales.sql"), "select 1");
  fs.writeFileSync(path.join(app, "bindings", "bad name.sql"), "select 1");
  fs.writeFileSync(path.join(app, "bindings", "notes.txt"), "x");
  return { root, app };
}

function fakeServer(root) {
  const handlers = [];
  const logs = { info: [], error: [] };
  return {
    server: {
      config: { root, logger: { info: m => logs.info.push(m), error: m => logs.error.push(m) } },
      middlewares: { use: h => handlers.push(h) },
    },
    handlers,
    logs,
  };
}

function request(handler, url, method) {
  return new Promise(resolve => {
    const chunks = [];
    const res = {
      statusCode: 200,
      headers: {},
      setHeader(k, v) { this.headers[k.toLowerCase()] = v; },
      end(body) { if (body) chunks.push(Buffer.from(body)); resolve({ status: this.statusCode, headers: this.headers, body: Buffer.concat(chunks) }); },
      write(c) { chunks.push(Buffer.from(c)); },
      on() {}, once() {}, emit() {},
    };
    // createReadStream(...).pipe(res) support
    res.pipe = undefined;
    const next = () => resolve({ status: "next" });
    handler({ url, method }, res, next);
  });
}

test("resolveMakoContext reads .env, workspace.json and the app slug", () => {
  const { app } = repo();
  const ctx = resolveMakoContext(app);
  assert.equal(ctx.apiUrl, "https://api.test");
  assert.equal(ctx.apiKey, "k-1");
  assert.equal(ctx.workspaceId, "ws1");
  assert.equal(ctx.slug, "my-app");
  const env = { ...process.env };
  process.env.MAKO_API_KEY = "from-env";
  try {
    assert.equal(resolveMakoContext(app).apiKey, "from-env", "process.env wins");
  } finally {
    process.env = env;
  }
});

test("index.json lists valid bindings from disk; other paths fall through", async () => {
  const { root, app } = repo();
  const { server, handlers } = fakeServer(app);
  makoData().configureServer(server);
  const r = await request(handlers[0], "/__data/index.json");
  assert.deepEqual(JSON.parse(r.body.toString()), ["sales"]);
  assert.equal((await request(handlers[0], "/src/App.tsx")).status, "next");
  assert.equal((await request(handlers[0], "/__data/..%2Fetc.parquet")).status, 400);
  fs.rmSync(root, { recursive: true, force: true });
});

test("an API without dev builds: committed artifact, materialized on 404, cached", async () => {
  const { app } = repo();
  const calls = [];
  const realFetch = globalThis.fetch;
  let artifactMissing = true;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", auth: init.headers?.authorization });
    if (String(url).endsWith("/materialize")) { artifactMissing = false; return new Response("{}", { status: 200 }); }
    // An older API answers the unknown dev-build route with its plain 404.
    if (artifactMissing || String(url).endsWith("/dev-build")) return new Response("404 Not Found", { status: 404 });
    return new Response(Buffer.from("PAR1data"), { status: 200 });
  };
  try {
    const { server, handlers } = fakeServer(app);
    makoData().configureServer(server);
    const r1 = await request(handlers[0], "/__data/sales.parquet");
    assert.equal(r1.status, 200);
    assert.equal(r1.headers["content-type"], "application/vnd.apache.parquet");
    assert.equal(r1.headers["x-mako-data"], "api");
    assert.equal(r1.body.toString(), "PAR1data");
    assert.deepEqual(calls.map(c => c.method + " " + c.url.split("/apps/")[1]), [
      "POST my-app/bindings/sales/dev-build",
      "GET my-app/bindings/sales/artifact",
      "POST my-app/bindings/sales/materialize",
      "GET my-app/bindings/sales/artifact",
    ]);
    assert.ok(calls.every(c => c.auth === "Bearer k-1"));
    assert.ok(calls[0].url.startsWith("https://api.test/api/workspaces/ws1/apps/my-app/"));
    assert.ok(fs.existsSync(path.join(app, "node_modules", ".mako-data", "sales.parquet")));
    // Cached by age, and the unsupported route is not asked again.
    const r2 = await request(handlers[0], "/__data/sales.parquet");
    assert.equal(r2.status, 200);
    assert.equal(calls.length, 4);
  } finally {
    globalThis.fetch = realFetch;
  }
});

// A fake API that builds whatever text it is sent, so a test can see which
// text reached it.
function devBuildApi(calls, { failWith } = {}) {
  return async (url, init = {}) => {
    const body = init.body ? JSON.parse(init.body) : undefined;
    calls.push({ url: String(url), method: init.method ?? "GET", body });
    if (failWith) return failWith();
    return new Response(Buffer.from(`PAR1:${body.source}`), {
      status: 200,
      headers: {
        "x-mako-build": "draft",
        "x-mako-row-count": "4",
        "x-mako-materialized-at": "2026-09-28T10:00:00.000Z",
      },
    });
  };
}

test("parquet: built from the LOCAL binding text, cached by that text", async () => {
  const { app } = repo();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = devBuildApi(calls);
  try {
    const { server, handlers } = fakeServer(app);
    // Infinity: the setting apps use to avoid re-downloading big files.
    makoData({ revalidateMs: Infinity }).configureServer(server);
    const r1 = await request(handlers[0], "/__data/sales.parquet");
    assert.equal(r1.status, 200);
    assert.equal(r1.headers["x-mako-data"], "api");
    assert.equal(r1.body.toString(), "PAR1:select 1");
    assert.equal(calls[0].method + " " + calls[0].url.split("/apps/")[1], "POST my-app/bindings/sales/dev-build");
    assert.deepEqual(calls[0].body, { source: "select 1" });

    const r2 = await request(handlers[0], "/__data/sales.parquet");
    assert.equal(r2.headers["x-mako-data"], "cache");
    assert.equal(calls.length, 1);

    // Editing the binding invalidates the cache, however long it may live.
    fs.writeFileSync(path.join(app, "bindings", "sales.sql"), "select 1 as connected");
    const r3 = await request(handlers[0], "/__data/sales.parquet");
    assert.equal(r3.headers["x-mako-data"], "api");
    assert.equal(r3.body.toString(), "PAR1:select 1 as connected");
    assert.equal(calls.length, 2);
    assert.deepEqual(calls[1].body, { source: "select 1 as connected" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("offline: stale data only when it was built from the same text", async () => {
  const { app } = repo();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = devBuildApi(calls);
  try {
    const { server, handlers } = fakeServer(app);
    makoData().configureServer(server);
    assert.equal((await request(handlers[0], "/__data/sales.parquet")).status, 200);

    globalThis.fetch = async () => { throw new TypeError("fetch failed", { cause: { code: "ENOTFOUND" } }); };
    // ?refresh skips the fresh cache, so the API is asked (and unreachable).
    const stale = await request(handlers[0], "/__data/sales.parquet?refresh=1");
    assert.equal(stale.status, 200);
    assert.equal(stale.headers["x-mako-data"], "stale");
    assert.equal(stale.body.toString(), "PAR1:select 1");

    // After an edit, the old query's parquet is not a stale copy of the new one.
    fs.writeFileSync(path.join(app, "bindings", "sales.sql"), "select 2");
    const refused = await request(handlers[0], "/__data/sales.parquet");
    assert.equal(refused.status, 502);
    assert.match(JSON.parse(refused.body.toString()).error, /cannot reach the Mako API/);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a failed build relays the API's status and message", async () => {
  const { app } = repo();
  const realFetch = globalThis.fetch;
  globalThis.fetch = devBuildApi([], {
    failWith: () =>
      new Response(JSON.stringify({ success: false, error: "Unrecognized name: connected" }), {
        status: 502,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    const { server, handlers } = fakeServer(app);
    makoData().configureServer(server);
    const r = await request(handlers[0], "/__data/sales.parquet");
    assert.equal(r.status, 502);
    assert.equal(JSON.parse(r.body.toString()).error, "Unrecognized name: connected");
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("dbtEnvironment (option or MAKO_DBT_ENV) is sent and keys the cache", async () => {
  const { app, root } = repo();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = devBuildApi(calls);
  try {
    fs.appendFileSync(path.join(root, ".env"), "MAKO_DBT_ENV=joan\n");
    assert.equal(resolveMakoContext(app).dbtEnvironment, "joan");
    assert.equal(resolveMakoContext(app, { dbtEnvironment: "ci" }).dbtEnvironment, "ci");

    const { server, handlers, logs } = fakeServer(app);
    makoData({ revalidateMs: Infinity }).configureServer(server);
    assert.match(logs.info[0], /dbt environment "joan"/);
    await request(handlers[0], "/__data/sales.parquet");
    assert.deepEqual(calls[0].body, { source: "select 1", dbtEnvironment: "joan" });

    // Same text, another environment: not the same data.
    const other = fakeServer(app);
    makoData({ revalidateMs: Infinity, dbtEnvironment: "prod" }).configureServer(other.server);
    const r = await request(other.handlers[0], "/__data/sales.parquet");
    assert.equal(r.headers["x-mako-data"], "api");
    assert.deepEqual(calls[1].body, { source: "select 1", dbtEnvironment: "prod" });
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("a scoped credential refused by an older API falls back to committed artifacts", async () => {
  const { app } = repo();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push((init.method ?? "GET") + " " + String(url).split("/apps/")[1]);
    if (String(url).endsWith("/dev-build")) {
      return new Response(
        JSON.stringify({ error: "MCP OAuth tokens are restricted to the /api/mcp endpoint (plus read-only app binding routes)" }),
        { status: 403 },
      );
    }
    return new Response(Buffer.from("PAR1data"), { status: 200 });
  };
  try {
    const { server, handlers } = fakeServer(app);
    makoData().configureServer(server);
    const r = await request(handlers[0], "/__data/sales.parquet");
    assert.equal(r.status, 200);
    assert.deepEqual(calls, ["POST my-app/bindings/sales/dev-build", "GET my-app/bindings/sales/artifact"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("bindingFingerprint depends on the text and the dbt environment", () => {
  assert.equal(bindingFingerprint("select 1"), bindingFingerprint("select 1", ""));
  assert.notEqual(bindingFingerprint("select 1"), bindingFingerprint("select 1 "));
  assert.notEqual(bindingFingerprint("select 1", "joan"), bindingFingerprint("select 1"));
});

test("no credentials → 503 with a hint, never index.html", async () => {
  const { app, root } = repo();
  fs.rmSync(path.join(root, ".env"));
  const { server, handlers, logs } = fakeServer(app);
  makoData().configureServer(server);
  assert.match(logs.info[0], /NOT CONNECTED/);
  const r = await request(handlers[0], "/__data/sales.parquet");
  assert.equal(r.status, 503);
  assert.match(JSON.parse(r.body.toString()).hint, /MAKO_API_KEY/);
});

test("POST __data/<name>/refresh rebuilds the local text through the API and caches it", async () => {
  const { app } = repo();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = devBuildApi(calls);
  try {
    const { server, handlers } = fakeServer(app);
    makoData({ revalidateMs: Infinity }).configureServer(server);
    assert.equal((await request(handlers[0], "/__data/sales.parquet")).status, 200);

    const r = await request(handlers[0], "/__data/sales/refresh", "POST");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body.toString()), {
      success: true,
      binding: "sales",
      materialization: "parquet",
      rowCount: 4,
      byteSize: Buffer.byteLength("PAR1:select 1"),
      materializedAt: "2026-09-28T10:00:00.000Z",
    });
    assert.deepEqual(calls[1].body, { source: "select 1", refresh: true });
    // The rebuilt parquet is what the next read serves, from the cache.
    const next = await request(handlers[0], "/__data/sales.parquet");
    assert.equal(next.headers["x-mako-data"], "cache");
    assert.equal(calls.length, 2);

    // Not a POST → 405; a bad name → 400; both before any API call.
    assert.equal((await request(handlers[0], "/__data/sales/refresh")).status, 405);
    assert.equal((await request(handlers[0], "/__data/..%2Fx/refresh", "POST")).status, 400);
    assert.equal(calls.length, 2);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("materialize: false never builds: committed artifacts only", async () => {
  const { app } = repo();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push((init.method ?? "GET") + " " + String(url).split("/apps/")[1]);
    return new Response(Buffer.from("PAR1data"), { status: 200 });
  };
  try {
    const { server, handlers } = fakeServer(app);
    makoData({ materialize: false }).configureServer(server);
    assert.equal((await request(handlers[0], "/__data/sales.parquet")).status, 200);
    assert.deepEqual(calls, ["GET my-app/bindings/sales/artifact"]);
  } finally {
    globalThis.fetch = realFetch;
  }
});

test("refresh relays the API's refusal with its message", async () => {
  const { app } = repo();
  const realFetch = globalThis.fetch;
  globalThis.fetch = async () =>
    new Response(JSON.stringify({ success: false, error: "You have read-only access to this app." }), { status: 403 });
  try {
    const { server, handlers } = fakeServer(app);
    makoData().configureServer(server);
    const r = await request(handlers[0], "/__data/sales/refresh", "POST");
    assert.equal(r.status, 403);
    assert.deepEqual(JSON.parse(r.body.toString()), {
      success: false,
      error: "You have read-only access to this app.",
    });
  } finally {
    globalThis.fetch = realFetch;
  }
});

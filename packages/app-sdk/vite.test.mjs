import { test } from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { makoData, resolveMakoContext } from "./vite.js";

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

test("parquet: fetched from the API with the key, materialized on 404, cached", async () => {
  const { app } = repo();
  const calls = [];
  const realFetch = globalThis.fetch;
  let artifactMissing = true;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET", auth: init.headers?.authorization });
    if (String(url).endsWith("/materialize")) { artifactMissing = false; return new Response("{}", { status: 200 }); }
    if (artifactMissing) return new Response("nope", { status: 404 });
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
      "GET my-app/bindings/sales/artifact",
      "POST my-app/bindings/sales/materialize",
      "GET my-app/bindings/sales/artifact",
    ]);
    assert.ok(calls.every(c => c.auth === "Bearer k-1"));
    assert.ok(calls[0].url.startsWith("https://api.test/api/workspaces/ws1/apps/my-app/"));
    assert.ok(fs.existsSync(path.join(app, "node_modules", ".mako-data", "sales.parquet")));
  } finally {
    globalThis.fetch = realFetch;
  }
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

test("POST __data/<name>/refresh materializes through the API and drops the cache", async () => {
  const { app } = repo();
  const calls = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method ?? "GET" });
    if (String(url).endsWith("/materialize")) {
      return new Response(
        JSON.stringify({ success: true, rowCount: 7, byteSize: 99, materializedAt: "2026-09-02T10:00:00.000Z" }),
        { status: 200 },
      );
    }
    return new Response(Buffer.from("PAR1data"), { status: 200 });
  };
  try {
    const { server, handlers } = fakeServer(app);
    makoData().configureServer(server);
    // Warm the cache, then refresh: the cached copy must go so the next read
    // is the rebuilt artifact, not the five-minute-old one.
    assert.equal((await request(handlers[0], "/__data/sales.parquet")).status, 200);
    const cached = path.join(app, "node_modules", ".mako-data", "sales.parquet");
    assert.ok(fs.existsSync(cached));

    const r = await request(handlers[0], "/__data/sales/refresh", "POST");
    assert.equal(r.status, 200);
    assert.deepEqual(JSON.parse(r.body.toString()), {
      success: true,
      binding: "sales",
      materialization: "parquet",
      rowCount: 7,
      byteSize: 99,
      materializedAt: "2026-09-02T10:00:00.000Z",
    });
    assert.ok(!fs.existsSync(cached), "cache dropped");
    assert.deepEqual(calls.map(c => c.method + " " + c.url.split("/apps/")[1]), [
      "GET my-app/bindings/sales/artifact",
      "POST my-app/bindings/sales/materialize",
    ]);

    // Not a POST → 405; a bad name → 400; both before any API call.
    assert.equal((await request(handlers[0], "/__data/sales/refresh")).status, 405);
    assert.equal((await request(handlers[0], "/__data/..%2Fx/refresh", "POST")).status, 400);
    assert.equal(calls.length, 2);
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

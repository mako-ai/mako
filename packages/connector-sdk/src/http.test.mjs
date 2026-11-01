import { test } from "node:test";
import assert from "node:assert/strict";
import { createHttp, proxiedFetch } from "./http.js";
import { createContext } from "./define.js";

const PROXY = { url: "https://mako.example.com/api/connections/sandbox-fetch", token: "mkr_run" };

/** A fetch standing in for Mako's sandbox-fetch route. */
function fakeMako(answer) {
  const calls = [];
  const fetchImpl = async (url, init) => {
    calls.push({ url, init, sent: JSON.parse(init.body) });
    return new Response(JSON.stringify(answer), {
      status: 200,
      headers: { "content-type": "application/json" },
    });
  };
  return { calls, fetchImpl };
}

test("without a proxy, ctx.http fetches the vendor directly, as before", async () => {
  const seen = [];
  const http = createHttp({
    fetchImpl: async (url, init) => {
      seen.push({ url, init });
      return new Response('{"ok":true}', { status: 200 });
    },
  });
  assert.deepEqual(await http.get("https://api.vendor.example/x"), { ok: true });
  assert.equal(seen[0].url, "https://api.vendor.example/x");
});

test("with a proxy, every request goes to Mako with the run token, placeholders untouched", async () => {
  const body = Buffer.from(JSON.stringify({ data: [1] })).toString("base64");
  const mako = fakeMako({ status: 200, headers: { "content-type": "application/json" }, body });
  const http = createHttp({ proxy: PROXY, fetchImpl: mako.fetchImpl });
  const result = await http.get("https://api.close.com/api/v1/task/?_limit=1", {
    headers: { Authorization: "Basic bWFrby1zZWNyZXQ6YWJjL2FwaV9rZXk6" },
  });
  assert.deepEqual(result, { data: [1] });
  assert.equal(mako.calls[0].url, PROXY.url);
  assert.equal(mako.calls[0].init.headers.authorization, "Bearer mkr_run");
  assert.equal(mako.calls[0].sent.url, "https://api.close.com/api/v1/task/?_limit=1");
  assert.equal(mako.calls[0].sent.method, "GET");
  assert.equal(mako.calls[0].sent.headers.authorization, "Basic bWFrby1zZWNyZXQ6YWJjL2FwaV9rZXk6");
});

test("a POST body is passed as text", async () => {
  const mako = fakeMako({ status: 200, headers: {}, body: Buffer.from("{}").toString("base64") });
  const http = createHttp({ proxy: PROXY, fetchImpl: mako.fetchImpl });
  await http.post("https://api.vendor.example/q", { q: 1 });
  assert.equal(mako.calls[0].sent.body, '{"q":1}');
  assert.equal(mako.calls[0].sent.bodyEncoding, "text");
});

test("a vendor error comes back as the vendor's status; Mako's refusal as Mako's", async () => {
  const vendor = fakeMako({ status: 404, headers: {}, body: Buffer.from("nope").toString("base64") });
  await assert.rejects(
    createHttp({ proxy: PROXY, fetchImpl: vendor.fetchImpl, maxRetries: 0 }).get("https://v.example/x"),
    /HTTP 404/,
  );
  const refused = createHttp({
    proxy: PROXY,
    maxRetries: 0,
    fetchImpl: async () => new Response('{"error":"not a key of this connection"}', { status: 403 }),
  });
  await assert.rejects(refused.get("https://v.example/x"), /HTTP 403.*not a key of this connection/);
});

test("a 204 has no body", async () => {
  const res = await proxiedFetch(PROXY, fakeMako({ status: 204, headers: {}, body: "" }).fetchImpl)(
    "https://v.example/x",
  );
  assert.equal(res.status, 204);
});

test("ctx.createHttp inherits the proxy from config", async () => {
  const mako = fakeMako({ status: 200, headers: {}, body: Buffer.from("{}").toString("base64") });
  const ctx = createContext({ config: { __http: { proxy: PROXY } }, log: () => {} });
  const own = ctx.createHttp({ baseUrl: "https://ssl.bing.example", fetchImpl: mako.fetchImpl });
  await own.get("/api/x?apikey=mako-secret:abc/apiKey");
  assert.equal(mako.calls[0].sent.url, "https://ssl.bing.example/api/x?apikey=mako-secret:abc/apiKey");
});

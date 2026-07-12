import assert from "node:assert/strict";
import { afterEach, test } from "node:test";

import worker from "./worker.mjs";

const originalFetch = globalThis.fetch;

afterEach(() => {
  globalThis.fetch = originalFetch;
});

function createEnv(values = {}, bypassToken = "operator-secret") {
  return {
    MAKO_APP_ROUTING: {
      async get(key) {
        return values[key] ?? null;
      },
    },
    MAINTENANCE_BYPASS_TOKEN: bypassToken,
  };
}

function route(origin, maintenance = false) {
  return JSON.stringify({ origin, maintenance });
}

test("rejects unsupported hostnames", async () => {
  const response = await worker.fetch(
    new Request("https://other.mako.ai/"),
    createEnv(),
  );

  assert.equal(response.status, 404);
  assert.deepEqual(await response.json(), { error: "unsupported_host" });
});

test("fails closed when no origin is configured", async () => {
  const response = await worker.fetch(
    new Request("https://app.mako.ai/"),
    createEnv(),
  );

  assert.equal(response.status, 503);
  assert.deepEqual(await response.json(), { error: "origin_not_configured" });
});

test("blocks interactive traffic during maintenance", async () => {
  const response = await worker.fetch(
    new Request("https://app.mako.ai/dashboard"),
    createEnv({
      "route:app.mako.ai": route("https://old-origin.run.app", true),
    }),
  );

  assert.equal(response.status, 503);
  assert.equal(response.headers.get("Retry-After"), "300");
  assert.equal((await response.json()).error, "maintenance");
});

test("forwards raw webhook body and signature during maintenance", async () => {
  let upstreamRequest;
  globalThis.fetch = async request => {
    upstreamRequest = request;
    return new Response(JSON.stringify({ received: true }), {
      status: 200,
      headers: { "Content-Type": "application/json" },
    });
  };

  const rawBody = '{"id":"evt_123","type":"updated"}';
  const response = await worker.fetch(
    new Request(
      "https://app.mako.ai/api/webhooks/workspace-id/flow-id?source=test",
      {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          "Stripe-Signature": "signature-value",
        },
        body: rawBody,
      },
    ),
    createEnv({
      "route:app.mako.ai": route("https://old-origin.run.app", true),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(
    upstreamRequest.url,
    "https://old-origin.run.app/api/webhooks/workspace-id/flow-id?source=test",
  );
  assert.equal(upstreamRequest.headers.get("Stripe-Signature"), "signature-value");
  assert.equal(upstreamRequest.headers.get("X-Forwarded-Host"), "app.mako.ai");
  assert.equal(upstreamRequest.headers.get("X-Forwarded-Proto"), "https");
  assert.equal(await upstreamRequest.text(), rawBody);
});

test("allows an operator to bypass maintenance", async () => {
  globalThis.fetch = async () => new Response("ok");

  const response = await worker.fetch(
    new Request("https://app.mako.ai/dashboard", {
      headers: { "X-Mako-Maintenance-Token": "operator-secret" },
    }),
    createEnv({
      "route:app.mako.ai": route("https://old-origin.run.app", true),
    }),
  );

  assert.equal(response.status, 200);
  assert.equal(await response.text(), "ok");
});

test("rewrites redirects from the Cloud Run origin", async () => {
  globalThis.fetch = async () =>
    new Response(null, {
      status: 302,
      headers: {
        Location:
          "https://old-origin.run.app/api/auth/google/callback?complete=true",
      },
    });

  const response = await worker.fetch(
    new Request("https://app.mako.ai/api/auth/google/callback"),
    createEnv({
      "route:app.mako.ai": route("https://old-origin.run.app"),
    }),
  );

  assert.equal(response.status, 302);
  assert.equal(
    response.headers.get("Location"),
    "https://app.mako.ai/api/auth/google/callback?complete=true",
  );
});

test("streams the upstream response body without consuming it first", async () => {
  const encoder = new TextEncoder();
  globalThis.fetch = async () =>
    new Response(
      new ReadableStream({
        start(controller) {
          controller.enqueue(encoder.encode("data: first\n\n"));
          controller.enqueue(encoder.encode("data: second\n\n"));
          controller.close();
        },
      }),
      { headers: { "Content-Type": "text/event-stream" } },
    );

  const response = await worker.fetch(
    new Request("https://app.mako.ai/api/realtime"),
    createEnv({
      "route:app.mako.ai": route("https://old-origin.run.app"),
    }),
  );

  assert.equal(response.headers.get("Content-Type"), "text/event-stream");
  assert.equal(await response.text(), "data: first\n\ndata: second\n\n");
});

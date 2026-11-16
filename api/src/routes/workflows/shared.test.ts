/**
 * How the workflow routes answer a Hatchet failure (2026-11-16: a restarted
 * and an evicted Hatchet pod produced 56 silent 500s on the runs list).
 *
 * - Hatchet unreachable (connect error, timeout) or a gateway status in front
 *   of it: 503 + Retry-After, which the run view retries.
 * - Hatchet answering a 4xx: that status and its reason, as before.
 * - Any other Hatchet failure: 500 with its reason, never 502.
 *
 * Run: tsx src/routes/workflows/shared.test.ts
 */
import assert from "node:assert/strict";
import { createServer } from "node:net";
import { Hono } from "hono";
import { HatchetError, tenantJson } from "../../workflows/hatchet";
import { HATCHET_RETRY_AFTER_SECONDS, onRouteError } from "./shared";

function appThrowing(error: unknown): Hono {
  const app = new Hono();
  app.onError(onRouteError);
  app.get("/runs", () => {
    throw error;
  });
  return app;
}

async function answers() {
  const down = await appThrowing(
    new HatchetError("Hatchet is unreachable: fetch failed", 502, {
      unavailable: true,
      cause: new Error("connect ETIMEDOUT"),
    }),
  ).request("/runs");
  assert.equal(down.status, 503);
  assert.equal(
    down.headers.get("Retry-After"),
    String(HATCHET_RETRY_AFTER_SECONDS),
  );
  assert.equal(((await down.json()) as { success: boolean }).success, false);

  const notFound = await appThrowing(
    new HatchetError("Hatchet /runs failed (404): no such run", 404),
  ).request("/runs");
  assert.equal(notFound.status, 404);
  assert.equal(notFound.headers.get("Retry-After"), null);

  const broken = await appThrowing(
    new HatchetError("Hatchet /runs failed (500): boom", 500),
  ).request("/runs");
  assert.equal(broken.status, 500);
  assert.equal(broken.headers.get("Retry-After"), null);
}

/** A port that refuses connections: bind one, then close it. */
async function closedPort(): Promise<number> {
  const server = createServer();
  await new Promise<void>(r => server.listen(0, "127.0.0.1", r));
  const { port } = server.address() as { port: number };
  await new Promise<void>(r => server.close(() => r()));
  return port;
}

async function clientMarksUnavailable() {
  // Nothing listening: the client throws an unavailable HatchetError.
  const port = await closedPort();
  const tenant = {
    tenantId: "t",
    token: "x",
    apiUrl: `http://127.0.0.1:${port}`,
  };
  const refused = await tenantJson(tenant, "/api/v1/x").catch(e => e);
  assert.ok(refused instanceof HatchetError);
  assert.equal(refused.unavailable, true);
  assert.match(refused.message, /Hatchet is unreachable/);

  // A gateway status in front of Hatchet: unavailable too. A 404: not.
  const app = new Hono();
  app.get("/gw", c => c.text("no healthy upstream", 503));
  app.get("/missing", c => c.text("nope", 404));
  const { serve } = await import("@hono/node-server");
  const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" });
  await new Promise(r => server.once("listening", r));
  const live = {
    ...tenant,
    apiUrl: `http://127.0.0.1:${(server.address() as { port: number }).port}`,
  };
  try {
    const gw = (await tenantJson(live, "/gw").catch(e => e)) as HatchetError;
    assert.equal(gw.unavailable, true);
    assert.equal(gw.status, 503);
    const missing = (await tenantJson(live, "/missing").catch(
      e => e,
    )) as HatchetError;
    assert.equal(missing.unavailable, false);
    assert.equal(missing.status, 404);
  } finally {
    server.close();
  }
}

(async () => {
  await answers();
  await clientMarksUnavailable();
  console.info("workflows route error tests passed");
})().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

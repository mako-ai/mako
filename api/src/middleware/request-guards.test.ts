/**
 * The three request guards added after 2026-10-19 (one slow endpoint made
 * Cloud Run refuse ~1,700 requests): the per-instance concurrency pool, the
 * per-caller rate limit, and the edge-origin check.
 *
 * Run: tsx src/middleware/request-guards.test.ts
 */
import assert from "node:assert/strict";
import { Hono } from "hono";
import { concurrencyLimit, createConcurrencyPool } from "./concurrency-limit";
import {
  apiRateLimitMiddleware,
  resetRateLimitForTests,
  routeCost,
} from "./rate-limit";
import { edgeOriginMiddleware } from "./edge-origin";

const WS = "6846e6a01b05af0948070582";
const APP = "6a9411eb4c8b33609a65e665";

async function concurrencyPool() {
  const pool = createConcurrencyPool({ name: "t", max: 2, maxWaitMs: 50 });
  let release!: () => void;
  const gate = new Promise<void>(r => (release = r));
  const app = new Hono();
  app.get("/slow", concurrencyLimit(pool), async c => {
    await gate;
    return c.text("ok");
  });

  // Two run, the third waits, and is refused (not queued forever) when no
  // slot frees within maxWaitMs.
  const running = [app.request("/slow"), app.request("/slow")];
  await new Promise(r => setTimeout(r, 5));
  assert.equal(pool.active, 2);
  const refused = await app.request("/slow");
  assert.equal(refused.status, 503);
  assert.equal(refused.headers.get("Retry-After"), "2");

  // A waiter gets the slot the moment one frees.
  const waiting = app.request("/slow");
  await new Promise(r => setTimeout(r, 5));
  assert.equal(pool.waiting, 1);
  release();
  const statuses = (await Promise.all([...running, waiting])).map(
    r => r.status,
  );
  assert.deepEqual(statuses, [200, 200, 200]);
  assert.equal(pool.active, 0);
  assert.equal(pool.waiting, 0);

  // A handler that throws still releases its slot.
  const boom = new Hono();
  const pool2 = createConcurrencyPool({ name: "t2", max: 1, maxWaitMs: 10 });
  boom.get("/x", concurrencyLimit(pool2), () => {
    throw new Error("boom");
  });
  boom.onError((_e, c) => c.text("err", 500));
  assert.equal((await boom.request("/x")).status, 500);
  assert.equal(pool2.active, 0);
}

async function rateLimit() {
  // The costs that matter: the walk that took prod down outranks a read.
  assert.equal(routeCost(`/api/workspaces/${WS}/apps/${APP}/branches`), 5);
  assert.equal(routeCost(`/api/workspaces/${WS}/apps/${APP}/files`), 3);
  assert.equal(routeCost(`/api/workspaces/${WS}/apps`), 1);

  const build = () => {
    const app = new Hono();
    app.use("*", apiRateLimitMiddleware);
    app.all("*", c => c.text("ok"));
    return app;
  };
  const asAlice = { headers: { authorization: "Bearer alice" } };
  const asBob = { headers: { authorization: "Bearer bob" } };
  const branches = `/api/workspaces/${WS}/apps/${APP}/branches`;

  process.env.API_RATE_LIMIT_PER_MINUTE = "10";
  try {
    // enforce: two 5-cost calls fit, the third is refused with Retry-After;
    // another caller is unaffected.
    process.env.API_RATE_LIMIT_MODE = "enforce";
    resetRateLimitForTests();
    let app = build();
    assert.equal((await app.request(branches, asAlice)).status, 200);
    assert.equal((await app.request(branches, asAlice)).status, 200);
    const refused = await app.request(branches, asAlice);
    assert.equal(refused.status, 429);
    assert.ok(Number(refused.headers.get("Retry-After")) >= 1);
    assert.equal((await app.request(branches, asBob)).status, 200);

    // Exempt: Inngest steps and provider webhooks are never refused, and
    // non-API paths (the SPA) are not counted.
    for (let i = 0; i < 20; i++) {
      assert.equal((await app.request("/api/inngest", asAlice)).status, 200);
      assert.equal(
        (await app.request(`/api/webhooks/${WS}/x`, asAlice)).status,
        200,
      );
      assert.equal((await app.request("/index.html", asAlice)).status, 200);
    }

    // shadow (the default): over budget is logged, never refused.
    delete process.env.API_RATE_LIMIT_MODE;
    resetRateLimitForTests();
    app = build();
    for (let i = 0; i < 5; i++) {
      assert.equal((await app.request(branches, asAlice)).status, 200);
    }

    // Unauthenticated callers are keyed by client IP.
    process.env.API_RATE_LIMIT_MODE = "enforce";
    resetRateLimitForTests();
    app = build();
    const fromIp = (ip: string) => ({ headers: { "cf-connecting-ip": ip } });
    assert.equal((await app.request(branches, fromIp("1.1.1.1"))).status, 200);
    assert.equal((await app.request(branches, fromIp("1.1.1.1"))).status, 200);
    assert.equal((await app.request(branches, fromIp("1.1.1.1"))).status, 429);
    assert.equal((await app.request(branches, fromIp("2.2.2.2"))).status, 200);
  } finally {
    delete process.env.API_RATE_LIMIT_MODE;
    delete process.env.API_RATE_LIMIT_PER_MINUTE;
    resetRateLimitForTests();
  }
}

async function edgeOrigin() {
  const app = new Hono();
  app.use("*", edgeOriginMiddleware);
  app.all("*", c => c.text("ok"));
  const viaEdge = { headers: { "x-mako-edge": "s3cret" } };
  const wrong = { headers: { "x-mako-edge": "nope" } };

  try {
    // No secret configured: inert.
    assert.equal((await app.request("/api/workspaces")).status, 200);

    // Secret set, shadow by default: let through (and logged).
    process.env.EDGE_ORIGIN_SECRET = "s3cret";
    assert.equal((await app.request("/api/workspaces")).status, 200);

    process.env.EDGE_ORIGIN_CHECK = "enforce";
    assert.equal((await app.request("/api/workspaces")).status, 403);
    assert.equal((await app.request("/api/workspaces", wrong)).status, 403);
    assert.equal((await app.request("/api/workspaces", viaEdge)).status, 200);
    // Inngest calls the run.app URL directly by configuration; health probes
    // never pass through Cloudflare.
    assert.equal((await app.request("/api/inngest")).status, 200);
    assert.equal((await app.request("/health")).status, 200);
  } finally {
    delete process.env.EDGE_ORIGIN_SECRET;
    delete process.env.EDGE_ORIGIN_CHECK;
  }
}

async function main() {
  await concurrencyPool();
  await rateLimit();
  await edgeOrigin();
  console.info("request-guards: ok");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

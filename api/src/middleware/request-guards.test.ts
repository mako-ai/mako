/**
 * The three request guards added after 2026-10-19 (one slow endpoint made
 * Cloud Run refuse ~1,700 requests): the per-instance concurrency pool, the
 * per-caller rate limit, and the edge-origin check.
 *
 * Run: tsx src/middleware/request-guards.test.ts
 */
import assert from "node:assert/strict";
import { Hono } from "hono";
import {
  concurrencyLimit,
  createConcurrencyPool,
  POOL_WAITED_HEADER,
  shedWhileCloning,
} from "./concurrency-limit";
import { cloneInFlight } from "../apps/cloud-repo/clone-state";
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
  // It waited for a slot: marked, so the app's client does not retry it.
  assert.ok(Number(refused.headers.get(POOL_WAITED_HEADER)) >= 40);

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
    assert.equal((await app.request("/health/ready")).status, 200);
  } finally {
    delete process.env.EDGE_ORIGIN_SECRET;
    delete process.env.EDGE_ORIGIN_CHECK;
  }
}

/**
 * While this instance clones a workspace's repo and the pool is full, that
 * workspace's repo-work requests are refused at once (503 + Retry-After)
 * instead of waiting 10 s (2026-11-16). With a free slot they run and join
 * the clone, as before. Other workspaces still wait for a slot.
 */
async function shedWhileCloningRepo() {
  const pool = createConcurrencyPool({ name: "t3", max: 1, maxWaitMs: 5_000 });
  let unblock!: () => void;
  const blocker = new Promise<void>(r => (unblock = r));
  const app = new Hono();
  app.get(
    "/api/workspaces/:workspaceId/apps/:id/files",
    concurrencyLimit(pool, shedWhileCloning),
    async c => {
      if (c.req.query("hold")) await blocker;
      return c.text("ok");
    },
  );
  const OTHER = "6846e6a01b05af0948070583";
  const url = (ws: string, hold = false) =>
    `/api/workspaces/${ws}/apps/${APP}/files${hold ? "?hold=1" : ""}`;
  let finish!: () => void;
  cloneInFlight.set(WS, new Promise<void>(r => (finish = r)));
  try {
    // A free slot: the request runs, cloning or not.
    assert.equal((await app.request(url(WS))).status, 200);

    // The one slot is taken: a request for the cloning workspace is
    // refused at once and takes nothing.
    const holder = app.request(url(OTHER, true));
    await new Promise(r => setTimeout(r, 5));
    assert.equal(pool.active, 1);
    const started = Date.now();
    const shed = await app.request(url(WS));
    assert.equal(shed.status, 503);
    assert.equal(shed.headers.get("Retry-After"), "2");
    assert.equal(shed.headers.get(POOL_WAITED_HEADER), null, "retryable");
    assert.ok(Date.now() - started < 1_000, "refused without waiting");
    assert.equal(pool.waiting, 0, "did not queue");

    // Another workspace waits for the slot as before.
    const other = app.request(url(OTHER));
    await new Promise(r => setTimeout(r, 5));
    assert.equal(pool.waiting, 1);
    unblock();
    assert.equal((await holder).status, 200);
    assert.equal((await other).status, 200);
  } finally {
    unblock();
    finish();
    cloneInFlight.delete(WS);
  }
}

async function main() {
  await concurrencyPool();
  await shedWhileCloningRepo();
  await rateLimit();
  await edgeOrigin();
  console.info("request-guards: ok");
}

main().catch(error => {
  console.error(error);
  process.exitCode = 1;
});

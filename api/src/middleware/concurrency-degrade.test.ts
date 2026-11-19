/**
 * `degradeAfterMs`: a read that gets no slot in time runs without one and
 * serves its cheap answer, instead of a 503.
 *
 * 19 Nov 2026: two rollouts sent 45 and 60 app-page reads to one instance.
 * 12 held the repo-work slots for 3 to 18 s, and 39 waiters got 503 after
 * 10 s. The app page now answers those from the last commit.
 */
import { Hono } from "hono";
import { describe, expect, it } from "vitest";
import {
  appPageReads,
  concurrencyLimit,
  createConcurrencyPool,
  servedWithoutSlot,
  shedWhileCloning,
} from "./concurrency-limit";
import { cloneInFlight } from "../apps/cloud-repo/clone-state";

const WS = "6846e6a01b05af0948070582";
const APP = "6a9411eb4c8b33609a65e665";

/** One slot, held until `free()`. Reads report which answer they served. */
function setup(degradeAfterMs?: number) {
  const pool = createConcurrencyPool({ name: "t", max: 1, maxWaitMs: 200 });
  let free!: () => void;
  const held = new Promise<void>(r => (free = r));
  const app = new Hono();
  app.get(
    "/api/workspaces/:workspaceId/apps/:id/status",
    concurrencyLimit(pool, { ...shedWhileCloning, degradeAfterMs }),
    async c => {
      if (c.req.query("hold")) await held;
      return c.json({ offline: servedWithoutSlot(c) });
    },
  );
  const url = (hold = false) =>
    `/api/workspaces/${WS}/apps/${APP}/status${hold ? "?hold=1" : ""}`;
  return { pool, app, url, free };
}

async function timed(request: Response | Promise<Response>) {
  const started = Date.now();
  const response = await request;
  return { response, ms: Date.now() - started };
}

describe("app-page reads on a full pool", () => {
  it("adds no wait and serves the live read when a slot is free", async () => {
    const { app, url, pool } = setup(1_000);
    const { response, ms } = await timed(app.request(url()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ offline: false });
    expect(ms).toBeLessThan(100);
    expect(pool.active).toBe(0);
  });

  it("serves the last commit with 200 when no slot frees in time", async () => {
    const { app, url, pool, free } = setup(50);
    const holder = app.request(url(true));
    await new Promise(r => setTimeout(r, 5));
    expect(pool.active).toBe(1);

    const { response, ms } = await timed(app.request(url()));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ offline: true });
    // It waited the degrade budget, not the pool's 200 ms refusal wait.
    expect(ms).toBeGreaterThanOrEqual(40);
    expect(ms).toBeLessThan(200);
    // It ran without a slot and took none.
    expect(pool.active).toBe(1);
    expect(pool.waiting).toBe(0);

    // A second read in a row gets the same cheap answer, never a 503.
    const again = await app.request(url());
    expect(again.status).toBe(200);
    expect(await again.json()).toEqual({ offline: true });

    free();
    expect((await holder).status).toBe(200);
    expect(pool.active).toBe(0);

    // The slot is free again: the next read is live.
    const live = await app.request(url());
    expect(await live.json()).toEqual({ offline: false });
  });

  it("takes a slot that frees within the budget and stays live", async () => {
    const { app, url, pool, free } = setup(500);
    const holder = app.request(url(true));
    await new Promise(r => setTimeout(r, 5));
    const waiter = app.request(url());
    await new Promise(r => setTimeout(r, 5));
    expect(pool.waiting).toBe(1);
    free();
    expect(await (await waiter).json()).toEqual({ offline: false });
    expect((await holder).status).toBe(200);
  });

  it("still refuses with 503 on routes without a degrade budget", async () => {
    const { app, url, free } = setup(undefined);
    const holder = app.request(url(true));
    await new Promise(r => setTimeout(r, 5));
    expect((await app.request(url())).status).toBe(503);
    free();
    await holder;
  });

  it("still sheds at once while the workspace repo is cloning", async () => {
    // The last commit lives in that repo: there is nothing cheap to serve.
    const { app, url, free } = setup(50);
    const holder = app.request(url(true));
    await new Promise(r => setTimeout(r, 5));
    let finish!: () => void;
    cloneInFlight.set(WS, new Promise<void>(r => (finish = r)));
    try {
      const { response, ms } = await timed(app.request(url()));
      expect(response.status).toBe(503);
      expect(ms).toBeLessThan(40);
    } finally {
      finish();
      cloneInFlight.delete(WS);
      free();
      await holder;
    }
  });

  it("the app page's reads degrade after 3 s and keep clone shedding", () => {
    expect(appPageReads.degradeAfterMs).toBe(3_000);
    expect(appPageReads.shedWhen).toBe(shedWhileCloning.shedWhen);
  });
});

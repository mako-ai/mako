import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import {
  CdcTableWriteLease,
  TableWriteLease,
  TableWriteLeaseBusyError,
  acquireTableWriteLease,
  withTableWriteLease,
  type LeaseJobControl,
} from "./table-write-lease";

/**
 * The table write lease against an in-memory Mongo: one holder at a time,
 * handover on expiry, renewal, release only by the holder, release after a
 * failed MERGE, and a dead holder's job waited on.
 */

const FAST = { backoffMinMs: 10, backoffMaxMs: 20 } as const;
let mongo: MongoMemoryServer;
let n = 0;
let key: string;

beforeAll(async () => {
  mongo = await MongoMemoryServer.create();
  await mongoose.connect(mongo.getUri());
});

afterAll(async () => {
  await mongoose.disconnect();
  await mongo.stop();
});

beforeEach(() => {
  key = `proj.ds.table_${++n}`;
});

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function jobControl(state: {
  done: boolean;
  cancels: number;
}): LeaseJobControl {
  return {
    isDone: async () => state.done,
    cancel: async () => {
      state.cancels++;
    },
  };
}

describe("table write lease", () => {
  it("lets one of ten concurrent holders win", async () => {
    const results = await Promise.allSettled(
      Array.from({ length: 10 }, (_, i) =>
        acquireTableWriteLease(key, {
          path: "live",
          holder: `h${i}`,
          maxWaitMs: 100,
          ...FAST,
        }),
      ),
    );
    const won = results.filter(r => r.status === "fulfilled");
    const lost = results.filter(r => r.status === "rejected");
    expect(won).toHaveLength(1);
    expect(lost).toHaveLength(9);
    for (const r of lost) {
      expect((r as PromiseRejectedResult).reason).toBeInstanceOf(
        TableWriteLeaseBusyError,
      );
    }
    const doc = await CdcTableWriteLease.findById(key).lean();
    const winner = (won[0] as PromiseFulfilledResult<TableWriteLease>).value;
    expect(doc?.holder).toBe(winner.holder);
    await winner.release();
    expect(await CdcTableWriteLease.findById(key).lean()).toBeNull();
  });

  it("hands over to a waiter once the holder's lease expires", async () => {
    const a = await acquireTableWriteLease(key, {
      path: "flush",
      holder: "a",
      ttlMs: 200,
      renewMs: 60_000,
      ...FAST,
    });
    // a stops renewing, as a crashed worker would.
    (a as unknown as { stopRenewing(): void }).stopRenewing();
    const b = await acquireTableWriteLease(key, {
      path: "live",
      holder: "b",
      maxWaitMs: 2_000,
      ...FAST,
    });
    expect(b.waitMs).toBeGreaterThanOrEqual(150);
    expect((await CdcTableWriteLease.findById(key).lean())?.holder).toBe("b");
    // a's late release leaves b's lease alone.
    await a.release();
    expect((await CdcTableWriteLease.findById(key).lean())?.holder).toBe("b");
    await b.release();
    expect(await CdcTableWriteLease.findById(key).lean()).toBeNull();
  });

  it("renews a held lease past its TTL", async () => {
    const a = await acquireTableWriteLease(key, {
      path: "final",
      holder: "a",
      ttlMs: 300,
      renewMs: 80,
      ...FAST,
    });
    await sleep(900);
    await expect(
      acquireTableWriteLease(key, {
        path: "live",
        holder: "b",
        maxWaitMs: 100,
        ...FAST,
      }),
    ).rejects.toBeInstanceOf(TableWriteLeaseBusyError);
    const doc = await CdcTableWriteLease.findById(key).lean();
    expect(doc?.holder).toBe("a");
    expect(doc!.expiresAt.getTime()).toBeGreaterThan(Date.now());
    await a.release();
    const b = await acquireTableWriteLease(key, {
      path: "live",
      holder: "b",
      maxWaitMs: 100,
      ...FAST,
    });
    expect(b.waitMs).toBeLessThan(100);
    await b.release();
  });

  it("ignores a release by a non-holder", async () => {
    const a = await acquireTableWriteLease(key, {
      path: "poll",
      holder: "a",
      ...FAST,
    });
    const intruder = new TableWriteLease(key, "intruder", {
      path: "poll",
      ttlMs: 1_000,
      renewMs: 1_000,
    });
    await intruder.release();
    expect((await CdcTableWriteLease.findById(key).lean())?.holder).toBe("a");
    await a.release();
    expect(await CdcTableWriteLease.findById(key).lean()).toBeNull();
  });

  it("releases after a failed MERGE whose job is DONE", async () => {
    const job = { done: true, cancels: 0 };
    await expect(
      withTableWriteLease(
        key,
        { path: "flush", jobs: jobControl(job), ...FAST },
        async lease => {
          lease?.recordJob({ jobId: "job_failed", location: "EU" });
          throw new Error("BigQuery MERGE failed");
        },
      ),
    ).rejects.toThrow("BigQuery MERGE failed");
    expect(job.cancels).toBe(0);
    expect(await CdcTableWriteLease.findById(key).lean()).toBeNull();
    const next = await acquireTableWriteLease(key, {
      path: "live",
      maxWaitMs: 50,
      ...FAST,
    });
    expect(next.waitMs).toBeLessThan(50);
    await next.release();
  });

  it("cancels a still-running job and leaves its id for the next holder", async () => {
    const job = { done: false, cancels: 0 };
    await expect(
      withTableWriteLease(
        key,
        {
          path: "final",
          jobs: jobControl(job),
          ttlMs: 300,
          settleMs: 50,
          ...FAST,
        },
        async lease => {
          lease?.recordJob({ jobId: "job_timeout", location: "EU" });
          throw new Error("Query timed out after 900 seconds");
        },
      ),
    ).rejects.toThrow("timed out");
    expect(job.cancels).toBe(1);
    // The job would not stop: the lease stays, with the job recorded.
    const left = await CdcTableWriteLease.findById(key).lean();
    expect(left?.jobId).toBe("job_timeout");

    // The next writer takes the expired lease, then waits for the job.
    setTimeout(() => {
      job.done = true;
    }, 600);
    const next = await acquireTableWriteLease(key, {
      path: "live",
      jobs: jobControl(job),
      maxWaitMs: 5_000,
      ...FAST,
    });
    expect(next.waitMs).toBeGreaterThanOrEqual(550);
    const doc = await CdcTableWriteLease.findById(key).lean();
    expect(doc?.holder).toBe(next.holder);
    expect(doc?.jobId ?? null).toBeNull();
    await next.release();
  });

  it("runs without a lease when CDC_TABLE_WRITE_LEASE=off", async () => {
    process.env.CDC_TABLE_WRITE_LEASE = "off";
    try {
      const seen = await withTableWriteLease(
        key,
        { path: "live" },
        async lease => lease,
      );
      expect(seen).toBeUndefined();
      expect(await CdcTableWriteLease.findById(key).lean()).toBeNull();
    } finally {
      delete process.env.CDC_TABLE_WRITE_LEASE;
    }
  });
});

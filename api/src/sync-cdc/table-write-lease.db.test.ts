import { createHash } from "node:crypto";
import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";
import { MongoMemoryServer } from "mongodb-memory-server";
import mongoose from "mongoose";
import {
  CdcTableWriteLease,
  TableWriteLease,
  TableWriteLeaseBusyError,
  acquireTableWriteLease,
  withTableWriteLease,
  type LeaseJobControl,
  type LeaseJobRef,
} from "./table-write-lease";
import { stableStringify } from "./normalization";

const fingerprint = (intent: unknown) =>
  createHash("sha256").update(stableStringify(intent)).digest("hex");

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

  it("recovers a reserved write that appears after the submitting lease expires", async () => {
    const submitted = {
      jobId: "mako_reserved_job",
      location: "EU",
      intentFingerprint: fingerprint("late-submit"),
    };
    const observedRunning = Promise.withResolvers<void>();
    let state: "missing" | "running" | "done" = "missing";
    const cancel = vi.fn(async () => undefined);
    const isDone = vi.fn(async (job: LeaseJobRef) => {
      expect(job).toEqual({ ...submitted, reservedBeforeDispatch: true });
      if (state === "running") observedRunning.resolve();
      return (
        state === "done" || (state === "missing" && !job.reservedBeforeDispatch)
      );
    });
    const jobs = {
      isDone: async () => true,
      isReservedJobDone: isDone,
      cancel,
    };
    const first = await acquireTableWriteLease(key, {
      path: "live",
      holder: "first",
      jobs,
      ...FAST,
    });
    try {
      // The dispatch must wait for this Mongo write, not the provider response.
      await first.reserveJob(submitted);
      expect(await CdcTableWriteLease.findById(key).lean()).toMatchObject({
        holder: "first",
        jobId: submitted.jobId,
        jobLocation: "EU",
        jobReservedBeforeDispatch: true,
      });
      await CdcTableWriteLease.updateOne(
        { _id: key },
        { $set: { expiresAt: new Date(0) } },
      );

      // The old worker is gone. The delayed submission is still unknown to BigQuery.
      await expect(
        acquireTableWriteLease(key, {
          path: "live",
          holder: "too-early",
          maxWaitMs: 0,
          jobs,
          ...FAST,
        }),
      ).rejects.toBeInstanceOf(TableWriteLeaseBusyError);
      expect(await CdcTableWriteLease.findById(key).lean()).toMatchObject({
        jobId: submitted.jobId,
        jobReservedBeforeDispatch: true,
      });
      expect(cancel).not.toHaveBeenCalled();

      state = "running";
      await CdcTableWriteLease.updateOne(
        { _id: key },
        { $set: { expiresAt: new Date(0) } },
      );
      const entering = acquireTableWriteLease(key, {
        path: "live",
        holder: "restart",
        maxWaitMs: 2_000,
        jobs,
        ...FAST,
      });
      await Promise.race([observedRunning.promise, entering]);
      expect((await CdcTableWriteLease.findById(key).lean())?.jobId).toBe(
        submitted.jobId,
      );
      state = "done";
      const restart = await entering;
      expect((await CdcTableWriteLease.findById(key).lean())?.jobId).toBeNull();
      await restart.release();
    } finally {
      state = "done";
      await first.release();
    }
    expect(cancel).not.toHaveBeenCalled();
    expect(await CdcTableWriteLease.findById(key).lean()).toBeNull();
  });

  for (const submittedBeforeCrash of [false, true]) {
    it(`checks immutable inputs when the synthetic worker dies ${submittedBeforeCrash ? "after" : "before"} submit`, async () => {
      const intent: Readonly<{
        projectId: string;
        location: string;
        jobId: string;
        sql: string;
        priority: string;
        inputSnapshot: string;
        destination: string;
      }> = Object.freeze({
        projectId: "proj",
        location: "EU",
        jobId: "mako_same_job",
        sql: "INSERT INTO `proj.ds.live` SELECT id FROM `proj.ds.immutable_snapshot`",
        priority: "BATCH",
        inputSnapshot: "proj.ds.immutable_snapshot@generation-1",
        destination: "proj.ds.live",
      });
      const intentFingerprint = fingerprint(intent);
      const durableIntents = new Map([[intentFingerprint, intent]]);
      const identity = `${intent.projectId}/${intent.location}/${intent.jobId}`;
      const warehouse = new Map<
        string,
        { intent: typeof intent; done: boolean }
      >();
      const submit = (request: typeof intent) => {
        const key = `${request.projectId}/${request.location}/${request.jobId}`;
        if (warehouse.has(key)) return 409;
        warehouse.set(key, { intent: request, done: false });
        return 200;
      };
      const attempts: number[] = [];
      const cancel = vi.fn(async () => undefined);
      const jobs: LeaseJobControl = {
        isDone: async () => true,
        isReservedJobDone: async job => {
          const restored = durableIntents.get(job.intentFingerprint ?? "");
          if (
            !restored ||
            job.jobId !== restored.jobId ||
            job.location !== restored.location
          ) {
            return false;
          }
          attempts.push(submit(restored));
          const receipt = warehouse.get(
            `${restored.projectId}/${restored.location}/${restored.jobId}`,
          );
          return (
            receipt?.done === true &&
            fingerprint(receipt.intent) === job.intentFingerprint
          );
        },
        cancel,
      };
      const first = await acquireTableWriteLease(key, {
        path: "live",
        holder: "submitter",
        jobs,
        ...FAST,
      });
      const expire = () =>
        CdcTableWriteLease.updateOne(
          { _id: key },
          { $set: { expiresAt: new Date(0) } },
        );
      const reacquire = (holder: string) =>
        acquireTableWriteLease(key, {
          path: "live",
          holder,
          jobs,
          maxWaitMs: 0,
          ...FAST,
        });
      try {
        await first.reserveJob({ ...intent, intentFingerprint });
        if (submittedBeforeCrash) {
          expect(submit(intent)).toBe(200);
        }
        // The restart uses the persisted fingerprint and the same request identity.
        await expire();
        await expect(reacquire("restart-running")).rejects.toBeInstanceOf(
          TableWriteLeaseBusyError,
        );
        expect(warehouse.size).toBe(1);
        expect(attempts).toEqual(
          submittedBeforeCrash ? [409, 409] : [200, 409],
        );

        // Identical SQL is insufficient if the input generation or destination changed.
        for (const mismatched of [
          {
            ...intent,
            inputSnapshot: "proj.ds.immutable_snapshot@generation-2",
          },
          { ...intent, destination: "proj.ds.other" },
        ]) {
          warehouse.set(identity, { intent: mismatched, done: true });
          await expire();
          await expect(reacquire("restart-mismatch")).rejects.toBeInstanceOf(
            TableWriteLeaseBusyError,
          );
          expect(
            (await CdcTableWriteLease.findById(key).lean())
              ?.jobIntentFingerprint,
          ).toBe(intentFingerprint);
        }

        warehouse.set(identity, { intent, done: true });
        await expire();
        const recovered = await reacquire("restart-done");
        expect(warehouse.size).toBe(1);
        expect(attempts.filter(status => status === 200)).toHaveLength(
          submittedBeforeCrash ? 0 : 1,
        );
        await recovered.release();
      } finally {
        await first.release();
      }
      expect(cancel).not.toHaveBeenCalled();
      expect(await CdcTableWriteLease.findById(key).lean()).toBeNull();
    });
  }

  it("refuses to reserve a job after a successor takes the expired lease", async () => {
    const jobs = {
      ...jobControl({ done: true, cancels: 0 }),
      isReservedJobDone: async () => true,
    };
    const first = await acquireTableWriteLease(key, {
      path: "live",
      holder: "first",
      jobs,
      ...FAST,
    });
    await CdcTableWriteLease.updateOne(
      { _id: key },
      { $set: { expiresAt: new Date(0) } },
    );
    const successor = await acquireTableWriteLease(key, {
      path: "live",
      holder: "successor",
      jobs,
      ...FAST,
    });
    try {
      await expect(
        first.reserveJob({
          jobId: "stale",
          location: "EU",
          intentFingerprint: fingerprint("stale"),
        }),
      ).rejects.toBeInstanceOf(TableWriteLeaseBusyError);
      expect(await CdcTableWriteLease.findById(key).lean()).toMatchObject({
        holder: "successor",
      });
      expect(
        (await CdcTableWriteLease.findById(key).lean())?.jobId,
      ).toBeUndefined();
    } finally {
      await first.release();
      await successor.release();
    }
  });

  for (const lostAck of [false, true]) {
    it(`holds the reservation when Mongo acknowledgement ${lostAck ? "is lost" : "races release"}`, async () => {
      const job = {
        jobId: "pending_ack",
        location: "EU",
        intentFingerprint: fingerprint("pending"),
      };
      const jobs = {
        ...jobControl({ done: true, cancels: 0 }),
        isReservedJobDone: async () => false,
      };
      const lease = await acquireTableWriteLease(key, {
        path: "live",
        jobs,
        ...FAST,
      });
      const stored = Promise.withResolvers<void>();
      const ack = Promise.withResolvers<void>();
      const update = CdcTableWriteLease.updateOne.bind(CdcTableWriteLease);
      const spy = vi
        .spyOn(CdcTableWriteLease, "updateOne")
        .mockImplementationOnce((filter, updateDoc, options) => {
          const query = update(filter, updateDoc, options);
          const exec = query.exec.bind(query);
          query.exec = async () => {
            const result = await exec();
            stored.resolve();
            await ack.promise;
            if (lostAck) throw new Error("acknowledgement lost");
            return result;
          };
          return query;
        });
      try {
        const reservation = lease.reserveJob(job);
        const rejected = lostAck
          ? expect(reservation).rejects.toThrow("acknowledgement lost")
          : expect(reservation).rejects.toBeInstanceOf(
              TableWriteLeaseBusyError,
            );
        await stored.promise;
        const closing = lostAck ? undefined : lease.release();
        ack.resolve();
        await rejected;
        expect(() => lease.recordJob({ jobId: "other" })).toThrow(
          TableWriteLeaseBusyError,
        );
        await (closing ?? lease.release());
        expect(await CdcTableWriteLease.findById(key).lean()).toMatchObject({
          jobId: job.jobId,
          jobIntentFingerprint: job.intentFingerprint,
          jobReservedBeforeDispatch: true,
        });
      } finally {
        ack.resolve();
        spy.mockRestore();
        await lease.release();
      }
    });
  }

  it("keeps a same-ID reservation changed while recovery checks the receipt", async () => {
    const job = {
      jobId: "same-id",
      location: "EU",
      intentFingerprint: fingerprint("before"),
    };
    const replacement = {
      jobLocation: "US",
      jobIntentFingerprint: fingerprint("after"),
    };
    const jobs = {
      ...jobControl({ done: true, cancels: 0 }),
      isReservedJobDone: async (seen: LeaseJobRef) => {
        if (seen.intentFingerprint !== job.intentFingerprint) return false;
        await CdcTableWriteLease.updateOne({ _id: key }, { $set: replacement });
        return true;
      },
    };
    const lease = await acquireTableWriteLease(key, {
      path: "live",
      jobs,
      ...FAST,
    });
    try {
      await lease.reserveJob(job);
      await CdcTableWriteLease.updateOne(
        { _id: key },
        { $set: { expiresAt: new Date(0) } },
      );
      await expect(
        acquireTableWriteLease(key, {
          path: "live",
          jobs,
          maxWaitMs: 0,
          ...FAST,
        }),
      ).rejects.toBeInstanceOf(TableWriteLeaseBusyError);
      expect(await CdcTableWriteLease.findById(key).lean()).toMatchObject({
        ...replacement,
        jobId: job.jobId,
      });
    } finally {
      await lease.release();
    }
  });

  it("keeps a reservation through a legacy callback or terminal hint", async () => {
    const job = {
      jobId: "reserved",
      location: "EU",
      intentFingerprint: fingerprint("reserved"),
    };
    const jobs = {
      ...jobControl({ done: true, cancels: 0 }),
      isReservedJobDone: async () => false,
    };
    const lease = await acquireTableWriteLease(key, {
      path: "live",
      jobs,
      ...FAST,
    });
    try {
      await expect(lease.reserveJob({ ...job, jobId: "" })).rejects.toThrow(
        "requires a job ID",
      );
      await lease.reserveJob(job);
      lease.recordJob({ jobId: job.jobId, location: job.location });
      expect(() => lease.recordJob({ jobId: "other" })).toThrow(
        TableWriteLeaseBusyError,
      );
      lease.markJobDone();
    } finally {
      await lease.release();
    }
    expect(await CdcTableWriteLease.findById(key).lean()).toMatchObject({
      jobId: job.jobId,
      jobIntentFingerprint: job.intentFingerprint,
      jobReservedBeforeDispatch: true,
    });
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

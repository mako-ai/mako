/**
 * One writer at a time per live table, across flows and paths.
 *
 * A pruned MERGE is two queries: a probe that lists the live partitions
 * holding the staged keys, then the MERGE filtered to those partitions
 * (adapters/bigquery-sql.ts). Another MERGE that lands between the two can
 * move a key to a partition the first one did not probe, or insert a key the
 * first one did not see. The first MERGE then finds no match and inserts the
 * key a second time. Live consumers, polls, backfill flushes, rescues and a
 * second flow writing the same table all race this way. So every probe +
 * MERGE (and a repartition's CTAS + DROP + RENAME) runs under this lease.
 *
 * One Mongo document per live table, keyed by the schema cache key
 * (`project.dataset.table`). Keying on the table, not the flow, covers two
 * flows writing one table.
 *
 * - Acquire: an upsert filtered on `expiresAt <= now`. A held lease makes the
 *   upsert insert a second `_id`, which fails with a duplicate key: busy.
 *   Back off 250 ms to 2 s, give up after `maxWaitMs` and throw, so Inngest
 *   retries the step.
 * - Renew: every 60 s while held, to a 3 min TTL. A BATCH-priority MERGE can
 *   queue for minutes before it starts (services/bigquery-job-priority.ts).
 * - Job: the holder records its BigQuery job id. A holder that dies leaves
 *   the id behind. The next holder waits for that job to finish first.
 * - Release: `deleteOne({ _id, holder })`, only once the job is DONE. After a
 *   failure the job is checked, and cancelled when still running. A job that
 *   will not stop keeps the lease until it expires, and the id stays for the
 *   next holder to wait on.
 *
 * Patterns: the heartbeat lease of apps/binding-jobs.ts and the
 * claim-then-verify slot of dbt/dbt-run-queue.ts.
 *
 * `CDC_TABLE_WRITE_LEASE=off` skips the lease (kill switch, and the control
 * in the race tests).
 */
import { randomUUID } from "node:crypto";
import mongoose, { Schema } from "mongoose";
import { loggers } from "../logging";

const log = loggers.sync("cdc.table-write-lease");

export const TABLE_WRITE_LEASE_TTL_MS = 3 * 60_000;
export const TABLE_WRITE_LEASE_RENEW_MS = 60_000;
export const TABLE_WRITE_LEASE_BACKOFF_MIN_MS = 250;
export const TABLE_WRITE_LEASE_BACKOFF_MAX_MS = 2_000;
/** The live consumer gives up sooner: its batch is small and retried soon. */
export const TABLE_WRITE_LEASE_MAX_WAIT_LIVE_MS = 5 * 60_000;
export const TABLE_WRITE_LEASE_MAX_WAIT_BULK_MS = 10 * 60_000;
/** How long a failed holder waits for its cancelled job to reach DONE. */
const SETTLE_AFTER_CANCEL_MS = 60_000;

/** Which write path holds the lease: the `mako_merge_path` job label. */
export type CdcMergePath =
  "live" | "flush" | "final" | "rescue" | "poll" | "repartition";

export function tableWriteLeaseMaxWaitMs(path: CdcMergePath): number {
  return path === "live"
    ? TABLE_WRITE_LEASE_MAX_WAIT_LIVE_MS
    : TABLE_WRITE_LEASE_MAX_WAIT_BULK_MS;
}

export function tableWriteLeaseEnabled(): boolean {
  return process.env.CDC_TABLE_WRITE_LEASE !== "off";
}

export interface LeaseJobRef {
  jobId: string;
  location?: string;
  /** A dispatch may still land after a status lookup returns not found. */
  reservedBeforeDispatch?: boolean;
  intentFingerprint?: string;
  dispatchState?: "ready" | "attempted";
}

type ReservedJob = {
  jobId: string;
  location: string;
  intentFingerprint: string;
};

function reservedJobFilter(job: LeaseJobRef) {
  return {
    jobId: job.jobId,
    jobLocation: job.location,
    jobReservedBeforeDispatch: true,
    jobIntentFingerprint: job.intentFingerprint,
    jobDispatchState: job.dispatchState ?? null,
  };
}

function sameReservedJob(current: LeaseJobRef, expected: ReservedJob): boolean {
  return (
    current.reservedBeforeDispatch === true &&
    current.jobId === expected.jobId &&
    current.location === expected.location &&
    current.intentFingerprint === expected.intentFingerprint
  );
}

function validReservation(job: LeaseJobRef): boolean {
  return Boolean(
    job.jobId.trim() && job.location?.trim() && job.intentFingerprint?.trim(),
  );
}

/** Reads and stops a warehouse job. The adapter supplies BigQuery's. */
export interface LeaseJobControl {
  /** Legacy lookups may treat a missing job as done. */
  isDone(job: LeaseJobRef): Promise<boolean>;
  /** Reserved jobs require a matching immutable intent and an explicit DONE receipt. */
  isReservedJobDone?(job: LeaseJobRef): Promise<boolean>;
  cancel(job: LeaseJobRef): Promise<void>;
}

interface TableWriteLeaseDoc {
  _id: string;
  holder: string;
  expiresAt: Date;
  jobId?: string | null;
  jobLocation?: string | null;
  jobReservedBeforeDispatch?: boolean | null;
  jobIntentFingerprint?: string | null;
  jobDispatchState?: LeaseJobRef["dispatchState"] | null;
  flowId?: string | null;
  path?: string | null;
  acquiredAt?: Date;
}

export const CdcTableWriteLease =
  (mongoose.models.CdcTableWriteLease as mongoose.Model<TableWriteLeaseDoc>) ??
  mongoose.model<TableWriteLeaseDoc>(
    "CdcTableWriteLease",
    new Schema<TableWriteLeaseDoc>(
      {
        _id: { type: String, required: true },
        holder: { type: String, required: true },
        expiresAt: { type: Date, required: true },
        jobId: { type: String },
        jobLocation: { type: String },
        jobReservedBeforeDispatch: { type: Boolean },
        jobIntentFingerprint: { type: String },
        jobDispatchState: { type: String, enum: ["ready", "attempted"] },
        flowId: { type: String },
        path: { type: String },
        acquiredAt: { type: Date },
      },
      { collection: "cdc_table_write_leases", versionKey: false },
    ),
  );

export class TableWriteLeaseBusyError extends Error {
  constructor(
    readonly key: string,
    readonly waitedMs: number,
  ) {
    super(
      `Table ${key} is being written by another writer; gave up after ${Math.round(waitedMs / 1000)} s`,
    );
    this.name = "TableWriteLeaseBusyError";
  }
}

export interface AcquireTableWriteLeaseOptions {
  flowId?: string;
  path: CdcMergePath;
  /** Default: tableWriteLeaseMaxWaitMs(path). */
  maxWaitMs?: number;
  /** Tests shorten these. */
  ttlMs?: number;
  renewMs?: number;
  backoffMinMs?: number;
  backoffMaxMs?: number;
  /** How long a failed holder waits for its cancelled job to stop. */
  settleMs?: number;
  /** Needed to wait on a dead holder's job and to settle a failed one. */
  jobs?: LeaseJobControl;
  /** Resume only this exact reservation if dispatch has never been authorized. */
  resumeReservedJob?: ReservedJob;
  /** Tests name the holder; default a random UUID. */
  holder?: string;
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function isDuplicateKey(err: unknown): boolean {
  return (err as { code?: number } | null)?.code === 11000;
}

export class TableWriteLease {
  /** Milliseconds spent waiting for the lease (and for a dead holder's job). */
  waitMs = 0;
  private job: LeaseJobRef | undefined;
  private jobDone = true;
  private pendingWrites: Promise<unknown>[] = [];
  private renewTimer: NodeJS.Timeout | undefined;
  private released = false;
  private releasing = false;
  private reservationWrite?: Promise<void>;
  private reservationFailed = false;

  constructor(
    readonly key: string,
    readonly holder: string,
    private readonly opts: AcquireTableWriteLeaseOptions & {
      ttlMs: number;
      renewMs: number;
    },
  ) {}

  /** The job this holder (or a dead holder before it) is waiting on. */
  get currentJob(): LeaseJobRef | undefined {
    return this.job;
  }

  startRenewing(): void {
    this.renewTimer = setInterval(() => {
      void this.renew();
    }, this.opts.renewMs);
    this.renewTimer.unref?.();
  }

  /** Push expiresAt out by one TTL. False when the lease is no longer ours. */
  async renew(): Promise<boolean> {
    try {
      const res = await CdcTableWriteLease.updateOne(
        { _id: this.key, holder: this.holder },
        { $set: { expiresAt: new Date(Date.now() + this.opts.ttlMs) } },
      );
      if (res.matchedCount === 0 && !this.released) {
        log.error("Table write lease lost before release", {
          table: this.key,
          flowId: this.opts.flowId,
          path: this.opts.path,
        });
        return false;
      }
      return true;
    } catch (err) {
      log.warn("Table write lease renewal failed", {
        table: this.key,
        error: err instanceof Error ? err.message : String(err),
      });
      return false;
    }
  }

  /** Persist a caller-assigned job ID before the caller can dispatch it. */
  async reserveJob(
    job: ReservedJob,
    { guardDispatch = false }: { guardDispatch?: boolean } = {},
  ): Promise<void> {
    if (!validReservation(job)) {
      throw new Error(
        "A write reservation requires a job ID, location and intent fingerprint",
      );
    }
    if (
      this.releasing ||
      this.reservationWrite ||
      this.reservationFailed ||
      !this.jobDone ||
      !this.opts.jobs?.isReservedJobDone
    ) {
      throw new TableWriteLeaseBusyError(this.key, this.waitMs);
    }
    await this.finishReservationWrite(
      this.persistReservation({ ...job }, guardDispatch),
    );
  }

  /** Authorize one dispatch from the current holder of the exact reservation. */
  async beginReservedJobDispatch(expected: ReservedJob): Promise<void> {
    const current = this.job;
    if (
      this.releasing ||
      this.reservationWrite ||
      this.reservationFailed ||
      !current ||
      current.dispatchState !== "ready" ||
      !sameReservedJob(current, expected)
    ) {
      throw new TableWriteLeaseBusyError(this.key, this.waitMs);
    }
    await this.finishReservationWrite(this.persistDispatchStart(current));
  }

  private async finishReservationWrite(write: Promise<void>): Promise<void> {
    this.reservationWrite = write;
    try {
      await this.reservationWrite;
      if (this.releasing) {
        throw new TableWriteLeaseBusyError(this.key, this.waitMs);
      }
    } catch (error) {
      this.reservationFailed = true;
      throw error;
    } finally {
      this.reservationWrite = undefined;
    }
  }

  private async persistReservation(
    job: ReservedJob,
    guardDispatch: boolean,
  ): Promise<void> {
    await Promise.all(this.pendingWrites);
    const now = new Date();
    const dispatchState = guardDispatch ? "ready" : undefined;
    const result = await CdcTableWriteLease.updateOne(
      {
        _id: this.key,
        holder: this.holder,
        expiresAt: { $gt: now },
        jobId: this.job?.jobId ?? null,
      },
      {
        $set: {
          jobId: job.jobId,
          jobLocation: job.location,
          jobReservedBeforeDispatch: true,
          jobIntentFingerprint: job.intentFingerprint,
          jobDispatchState: dispatchState ?? null,
          expiresAt: new Date(now.getTime() + this.opts.ttlMs),
        },
      },
      { writeConcern: { w: "majority" } },
    );
    if (result.matchedCount !== 1) {
      throw new TableWriteLeaseBusyError(this.key, this.waitMs);
    }
    this.job = { ...job, reservedBeforeDispatch: true, dispatchState };
    this.jobDone = false;
  }

  private async persistDispatchStart(job: LeaseJobRef): Promise<void> {
    const now = new Date();
    const result = await CdcTableWriteLease.updateOne(
      {
        _id: this.key,
        holder: this.holder,
        expiresAt: { $gt: now },
        ...reservedJobFilter(job),
      },
      {
        $set: {
          jobDispatchState: "attempted",
          expiresAt: new Date(now.getTime() + this.opts.ttlMs),
        },
      },
      { writeConcern: { w: "majority" } },
    );
    if (result.matchedCount !== 1) {
      throw new TableWriteLeaseBusyError(this.key, this.waitMs);
    }
    this.job = { ...job, dispatchState: "attempted" };
  }

  /**
   * Record the job this holder started. Called from the query's job-started
   * callback, so the write is queued and awaited before release.
   */
  recordJob(job: LeaseJobRef): void {
    if (this.job?.reservedBeforeDispatch) {
      if (
        this.job.jobId !== job.jobId ||
        (job.location && this.job.location !== job.location)
      ) {
        throw new TableWriteLeaseBusyError(this.key, this.waitMs);
      }
      return;
    }
    if (this.reservationWrite || this.reservationFailed || this.releasing) {
      throw new TableWriteLeaseBusyError(this.key, this.waitMs);
    }
    this.job = job;
    this.jobDone = false;
    this.pendingWrites.push(
      CdcTableWriteLease.updateOne(
        {
          _id: this.key,
          holder: this.holder,
          jobReservedBeforeDispatch: { $ne: true },
        },
        {
          $set: {
            jobId: job.jobId,
            jobLocation: job.location ?? null,
            jobReservedBeforeDispatch: false,
            jobDispatchState: null,
          },
        },
      ).catch(err => {
        log.warn("Could not record the job on the table write lease", {
          table: this.key,
          jobId: job.jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }),
    );
  }

  /** Legacy acknowledgement. A reservation still requires its separate verifier. */
  markJobDone(): void {
    if (!this.job?.reservedBeforeDispatch) this.jobDone = true;
  }

  private async isJobDone(job: LeaseJobRef): Promise<boolean> {
    const jobs = this.opts.jobs;
    if (job.reservedBeforeDispatch) {
      return (
        validReservation(job) &&
        ((await jobs?.isReservedJobDone?.(job)) ?? false)
      );
    }
    return (await jobs?.isDone(job)) ?? true;
  }

  /**
   * Wait until a job reaches DONE, renewing the lease meanwhile (the timer
   * does). False when it is still running at the deadline.
   */
  private async waitJobDone(job: LeaseJobRef, deadline: number) {
    let delay = this.opts.backoffMinMs ?? TABLE_WRITE_LEASE_BACKOFF_MIN_MS;
    const maxDelay = this.opts.backoffMaxMs ?? TABLE_WRITE_LEASE_BACKOFF_MAX_MS;
    for (;;) {
      try {
        if (await this.isJobDone(job)) return true;
      } catch (err) {
        log.warn("Could not read a lease job's state", {
          table: this.key,
          jobId: job.jobId,
          error: err instanceof Error ? err.message : String(err),
        });
      }
      if (Date.now() >= deadline) return false;
      await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
      delay = Math.min(delay * 2, maxDelay);
    }
  }

  /** A dead holder left a job behind: wait for it before writing. */
  async waitForInheritedJob(job: LeaseJobRef, deadline: number) {
    this.job = job;
    this.jobDone = false;
    const resume = this.opts.resumeReservedJob;
    if (
      job.dispatchState === "ready" &&
      resume &&
      sameReservedJob(job, resume)
    ) {
      return;
    }
    const done = await this.waitJobDone(job, deadline);
    if (!done) {
      throw new TableWriteLeaseBusyError(this.key, this.waitMs);
    }
    const result = await CdcTableWriteLease.updateOne(
      {
        _id: this.key,
        holder: this.holder,
        ...(job.reservedBeforeDispatch
          ? reservedJobFilter(job)
          : { jobId: job.jobId, jobReservedBeforeDispatch: { $ne: true } }),
      },
      {
        $set: {
          jobId: null,
          jobLocation: null,
          jobReservedBeforeDispatch: null,
          jobIntentFingerprint: null,
          jobDispatchState: null,
        },
      },
    );
    if (result.matchedCount !== 1) {
      throw new TableWriteLeaseBusyError(this.key, this.waitMs);
    }
    this.jobDone = true;
    this.job = undefined;
  }

  /**
   * Release once the recorded job is DONE. After a failure the job may still
   * run (a client timeout): cancel it and wait up to a minute. A job that
   * will not stop keeps the lease until it expires, with its id recorded.
   */
  async release(): Promise<void> {
    if (this.releasing) return;
    this.releasing = true;
    await this.reservationWrite?.catch(() => undefined);
    await Promise.all(this.pendingWrites);
    if (this.job && !this.jobDone) {
      const jobs = this.opts.jobs;
      if (jobs) {
        let done = await this.isJobDone(this.job).catch(() => false);
        if (!done && !this.job.reservedBeforeDispatch) {
          await jobs.cancel(this.job).catch(err => {
            log.warn("Could not cancel the lease holder's job", {
              table: this.key,
              jobId: this.job?.jobId,
              error: err instanceof Error ? err.message : String(err),
            });
          });
          done = await this.waitJobDone(
            this.job,
            Date.now() + (this.opts.settleMs ?? SETTLE_AFTER_CANCEL_MS),
          );
        }
        this.jobDone = done;
      }
      if (!this.jobDone) {
        this.stopRenewing();
        this.released = true;
        log.warn("Job still running; table write lease left to expire", {
          table: this.key,
          jobId: this.job.jobId,
          flowId: this.opts.flowId,
          path: this.opts.path,
        });
        return;
      }
    }
    this.stopRenewing();
    this.released = true;
    await CdcTableWriteLease.deleteOne({
      _id: this.key,
      holder: this.holder,
      // An ambiguous Mongo acknowledgement may have stored a reservation we never saw.
      ...(this.job?.reservedBeforeDispatch
        ? reservedJobFilter(this.job)
        : { jobReservedBeforeDispatch: { $ne: true } }),
    });
  }

  private stopRenewing(): void {
    if (this.renewTimer) clearInterval(this.renewTimer);
    this.renewTimer = undefined;
  }
}

/**
 * Take the lease on one live table, waiting while another writer holds it.
 * Throws TableWriteLeaseBusyError after `maxWaitMs`.
 */
export async function acquireTableWriteLease(
  key: string,
  options: AcquireTableWriteLeaseOptions,
): Promise<TableWriteLease> {
  const ttlMs = options.ttlMs ?? TABLE_WRITE_LEASE_TTL_MS;
  const renewMs = options.renewMs ?? TABLE_WRITE_LEASE_RENEW_MS;
  const maxWaitMs = options.maxWaitMs ?? tableWriteLeaseMaxWaitMs(options.path);
  const holder = options.holder ?? randomUUID();
  const started = Date.now();
  const deadline = started + maxWaitMs;
  let delay = options.backoffMinMs ?? TABLE_WRITE_LEASE_BACKOFF_MIN_MS;
  const maxDelay = options.backoffMaxMs ?? TABLE_WRITE_LEASE_BACKOFF_MAX_MS;

  for (;;) {
    const now = new Date();
    let previous: TableWriteLeaseDoc | null | undefined;
    try {
      previous = await CdcTableWriteLease.findOneAndUpdate(
        { _id: key, expiresAt: { $lte: now } },
        {
          $set: {
            holder,
            expiresAt: new Date(now.getTime() + ttlMs),
            flowId: options.flowId ?? null,
            path: options.path,
            acquiredAt: now,
          },
        },
        { upsert: true, returnDocument: "before" },
      ).lean<TableWriteLeaseDoc>();
    } catch (err) {
      if (!isDuplicateKey(err)) throw err;
      previous = undefined;
    }

    if (previous !== undefined) {
      const lease = new TableWriteLease(key, holder, {
        ...options,
        ttlMs,
        renewMs,
      });
      lease.waitMs = Date.now() - started;
      lease.startRenewing();
      if (previous?.jobId || previous?.jobReservedBeforeDispatch) {
        log.warn("Previous table writer expired with a job; waiting for it", {
          table: key,
          jobId: previous.jobId,
          previousHolder: previous.holder,
          previousPath: previous.path,
        });
        try {
          await lease.waitForInheritedJob(
            {
              jobId: previous.jobId ?? "",
              location: previous.jobLocation ?? undefined,
              reservedBeforeDispatch:
                previous.jobReservedBeforeDispatch === true,
              intentFingerprint: previous.jobIntentFingerprint ?? undefined,
              dispatchState: previous.jobDispatchState ?? undefined,
            },
            deadline,
          );
        } catch (err) {
          await lease.release();
          throw err;
        }
        lease.waitMs = Date.now() - started;
      }
      return lease;
    }

    const waited = Date.now() - started;
    if (Date.now() >= deadline) {
      throw new TableWriteLeaseBusyError(key, waited);
    }
    await sleep(Math.min(delay, Math.max(0, deadline - Date.now())));
    delay = Math.min(delay * 2, maxDelay);
  }
}

/**
 * Run `fn` holding the table's lease, released in a finally once its job is
 * DONE. With CDC_TABLE_WRITE_LEASE=off, `fn` runs with no lease.
 */
export async function withTableWriteLease<T>(
  key: string,
  options: AcquireTableWriteLeaseOptions,
  fn: (lease: TableWriteLease | undefined) => Promise<T>,
): Promise<T> {
  if (!tableWriteLeaseEnabled()) return fn(undefined);
  const lease = await acquireTableWriteLease(key, options);
  try {
    return await fn(lease);
  } finally {
    await lease.release();
  }
}

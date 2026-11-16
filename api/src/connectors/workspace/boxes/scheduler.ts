/**
 * Leases on connector boxes (RFC connector-runtime §6, iteration 2).
 *
 * Every connector command (`spec`, `check`, `discover`, a `read` chunk, a
 * webhook batch) is a run, and a run holds a lease on one box for exactly as
 * long as it executes. A box belongs to one key, connection id plus bundle
 * hash, so connections never share a box and a new hash gets fresh boxes.
 *
 *   leased --release--> idle --idlePauseMs--> paused --TTL--> killed
 *     ^                   |                     |
 *     +------ lease ------+-------- lease ------+
 *
 * A lease starts with a ping; a box that fails it is killed and replaced. A
 * box is retired after `maxFailures` failed runs or `maxAgeMs`. The reaper
 * (`reap`, run every minute by Inngest) kills a box whose lease passed its
 * deadline or stopped beating, pauses idle boxes, and enforces the TTLs.
 *
 * Runs that find no free box and the connection at its box cap wait in a FIFO
 * queue per key. Each entry carries a priority already; iteration 3 orders by
 * it (box-signals.ts `queueScore`).
 */
import { createHash, randomBytes } from "node:crypto";
import {
  isSandboxGone,
  type SandboxExecContext,
} from "../../../apps/sandbox/provider";
import { loggers } from "../../../logging";
import {
  boxContext,
  sandboxBoxProvider,
  type BoxProvider,
} from "./box-provider";
import { getBoxSignals, type BoxSignals } from "./box-signals";
import {
  MongoBoxStore,
  type BoxExpect,
  type BoxRecord,
  type BoxState,
  type BoxStore,
} from "./box-store";
import { boxLeaseConfig, type BoxLeaseConfig } from "./config";
import { logBoxMetrics, type BoxMetrics, type LeaseSource } from "./metrics";

const logger = loggers.connector("box");

/** P1, steady (RFC §6.5). The default until iteration 3 assigns priorities. */
export const DEFAULT_RUN_PRIORITY = 1;
/** A chunk's own timeout when the caller does not say (sync-box.ts). */
const DEFAULT_COMMAND_MS = 10 * 60 * 1000;
const QUEUE_POLL_MS = 250;
/** A waiting entry lives this long unrefreshed; refreshed every 2 s. */
const QUEUE_ALIVE_MS = 30_000;
const QUEUE_REFRESH_MS = 2_000;
/**
 * A template claim whose snapshot never completed is dropped after this.
 * Far above any snapshot's duration, and a late snapshot whose claim is gone
 * is deleted by its taker (completeTemplate returns false), never orphaned.
 */
const TEMPLATE_CLAIM_MS = 60 * 60 * 1000;
/** A box stuck in pausing or killing this long is killed again. */
const STUCK_TRANSITION_MS = 5 * 60 * 1000;

export interface RunSpec {
  workspaceId: string;
  /**
   * The data source id. Runs with no connection pass a key of their own:
   * `spec:<workspaceId>` for a reconcile `spec`, which holds no credential.
   */
  connectionId: string;
  /** The bundle hash; the connector source sha until bundles exist. */
  bundleHash: string;
  command: string;
  priority?: number;
  /** The SDK runtime the run needs; selects the snapshot template. */
  runtimeId?: string;
  /** The command's own timeout; the lease deadline adds a margin. */
  timeoutMs?: number;
  /** Kill the box after this run (a connection that is not saved yet). */
  oneOff?: boolean;
}

export interface BoxLease {
  readonly boxId: string;
  readonly runId: string;
  /** Pass this to sync-box.ts: every command then runs in the leased box. */
  readonly ctx: SandboxExecContext;
  /** True when the box was created (or restored from a template) for this run. */
  readonly fresh: boolean;
  /** Count this run against the box's failure budget. */
  markFailed(reason: string): void;
  /**
   * The box can no longer be trusted (a run's cleanup failed, so its
   * credential or processes may remain): kill it on release.
   */
  markUnhealthy(reason: string): void;
  /** Record the runtime the box now holds, for its snapshot template. */
  noteRuntime(runtimeId: string): void;
  /**
   * What this box is known to hold, computed once per box incarnation in
   * this process: the install checks (runtime, connector) a warm box would
   * otherwise repeat every chunk. Forgotten when the box is resumed, killed,
   * gone, or a run in it fails; a new or restored box has a new id.
   */
  memo<T>(key: string, compute: () => Promise<T>): Promise<T>;
  /** Drop this box's memo (a run failed in a way a missing file explains). */
  forgetMemo(): void;
  /**
   * Snapshot this fresh box as its key's template, once per key. Call it
   * after the bundle is in place and BEFORE any credentialed command, so the
   * template holds code and runtime and never a credential or its residue.
   */
  snapshotPristine(runtimeId: string): Promise<void>;
}

interface Held {
  run: RunSpec;
  key: string;
  runId: string;
  box: BoxRecord;
  fresh: boolean;
  runtimeId: string | null;
  unhealthy: string | null;
}

export interface ReapSummary {
  killed: Record<string, number>;
  paused: number;
  templatesDeleted: number;
  counts: Record<BoxState, number>;
}

export interface SchedulerDeps {
  store: BoxStore;
  signals: BoxSignals;
  provider: BoxProvider;
  metrics?: BoxMetrics;
  config?: BoxLeaseConfig;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

export function boxKey(connectionId: string, bundleHash: string): string {
  return `${connectionId}:${bundleHash}`;
}

export function templateKeyOf(key: string, runtimeId: string): string {
  return `${key}:${runtimeId}`;
}

/** E2B template names: lowercase, digits and dashes. */
function snapshotName(templateKey: string): string {
  return `mako-cbox-${createHash("sha256").update(templateKey).digest("hex").slice(0, 24)}`;
}

const message = (error: unknown): string =>
  error instanceof Error ? error.message : String(error);

export class BoxScheduler {
  readonly config: BoxLeaseConfig;
  private readonly store: BoxStore;
  private readonly signals: BoxSignals;
  private readonly provider: BoxProvider;
  private readonly metrics: BoxMetrics;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** Per box: what it is known to hold (BoxLease.memo). */
  private readonly memos = new Map<string, Map<string, unknown>>();

  private memoFor(boxId: string): Map<string, unknown> {
    let box = this.memos.get(boxId);
    if (!box) {
      // Boxes another process killed never come back; keep this bounded.
      if (this.memos.size >= 2_000) {
        const oldest = this.memos.keys().next().value;
        if (oldest !== undefined) this.memos.delete(oldest);
      }
      box = new Map();
      this.memos.set(boxId, box);
    }
    return box;
  }

  private readonly idleTimers = new Map<
    string,
    ReturnType<typeof setTimeout>
  >();

  constructor(deps: SchedulerDeps) {
    this.store = deps.store;
    this.signals = deps.signals;
    this.provider = deps.provider;
    this.metrics = deps.metrics ?? logBoxMetrics;
    this.config = deps.config ?? boxLeaseConfig();
    this.now = deps.now ?? Date.now;
    this.sleep =
      deps.sleep ?? (ms => new Promise(resolve => setTimeout(resolve, ms)));
  }

  /** Run `fn` holding a lease; the lease is released however `fn` ends. */
  async withLease<T>(
    run: RunSpec,
    fn: (lease: BoxLease) => Promise<T>,
  ): Promise<T> {
    const held = await this.acquire(run);
    const beat = setInterval(() => {
      void this.heartbeat(held);
    }, this.config.heartbeatMs);
    beat.unref?.();
    let failure: string | null = null;
    const lease: BoxLease = {
      boxId: held.box.boxId,
      runId: held.runId,
      ctx: boxContext(held.box),
      fresh: held.fresh,
      markFailed: reason => {
        failure ??= reason;
      },
      markUnhealthy: reason => {
        held.unhealthy ??= reason;
        failure ??= reason;
      },
      noteRuntime: runtimeId => {
        held.runtimeId = runtimeId;
      },
      snapshotPristine: runtimeId => this.snapshotPristine(held, runtimeId),
      memo: async <T>(key: string, compute: () => Promise<T>) => {
        const box = this.memoFor(held.box.boxId);
        if (box.has(key)) return box.get(key) as T;
        const value = await compute();
        box.set(key, value);
        return value;
      },
      forgetMemo: () => {
        this.memos.delete(held.box.boxId);
      },
    };
    try {
      return await fn(lease);
    } catch (error) {
      failure ??= message(error);
      this.memos.delete(held.box.boxId);
      // Leased without a ping, a box can turn out to be gone at the first
      // command. Never hand it out again: the next run gets a new box.
      if (isSandboxGone(error)) held.unhealthy ??= "box gone";
      throw error;
    } finally {
      clearInterval(beat);
      await this.release(held, failure).catch(error =>
        logger.error("Could not release a connector box lease", {
          boxId: held.box.boxId,
          error: message(error),
        }),
      );
    }
  }

  /**
   * Take a box for this run, waiting in the key's queue if the connection is
   * at its box cap. Exposed for tests; callers use `withLease`.
   */
  async acquire(run: RunSpec): Promise<Held> {
    const key = boxKey(run.connectionId, run.bundleHash);
    const runId = `run_${randomBytes(8).toString("hex")}`;
    const started = this.now();
    const entry = {
      runId,
      priority: run.priority ?? DEFAULT_RUN_PRIORITY,
      enqueuedAt: started,
    };

    // A new hash for this connection: its older boxes drain and die.
    if (!run.oneOff) {
      await this.store.drainOtherHashes(run.connectionId, run.bundleHash);
    }

    // The queue orders runs; Mongo enforces the limits. When the queue's
    // store (Redis) is down, a run proceeds without it rather than fail.
    let queueless = false;
    const queueDown = (error: unknown) => {
      if (!queueless) {
        logger.warn("Connector box queue unavailable; leasing without it", {
          key,
          error: message(error),
        });
      }
      queueless = true;
    };
    await this.signals.enqueue(key, entry, QUEUE_ALIVE_MS).catch(queueDown);
    // Refreshed for the whole wait, tryLease included: a slow ping or
    // restore must not let a peer drop this run from the queue as dead.
    const refresh = setInterval(() => {
      if (!queueless) {
        void this.signals
          .ensure(key, entry, QUEUE_ALIVE_MS)
          .catch(() => undefined);
      }
    }, QUEUE_REFRESH_MS);
    refresh.unref?.();
    let queued = false;
    try {
      for (;;) {
        let head = queueless;
        if (!head) {
          head = await this.signals.isHead(key, runId).catch(error => {
            queueDown(error);
            return true;
          });
        }
        if (head) {
          const got = await this.tryLease(run, key, runId);
          if (got) {
            this.metrics.leaseWait(this.now() - started, {
              workspaceId: run.workspaceId,
              connectionId: run.connectionId,
              command: run.command,
              source: got.source,
              queued,
            });
            return {
              run,
              key,
              runId,
              box: got.box,
              fresh: got.fresh,
              runtimeId: got.box.runtimeId,
              unhealthy: null,
            };
          }
        }
        if (this.now() - started >= this.config.queueWaitMs) {
          const depth = await this.signals.depth(key).catch(() => -1);
          throw new Error(
            `No connector box for this connection after ${Math.round(this.config.queueWaitMs / 1000)} s. ` +
              `${depth >= 0 ? `${depth} runs are waiting. ` : ""}` +
              `At most ${this.config.maxPerConnection} boxes run per connection, and connector boxes ` +
              `stop at ${this.config.accountCeiling - this.config.appReserve} running boxes on the account, app sessions included.`,
          );
        }
        queued = true;
        if (!queueless) {
          await this.signals
            .ensure(key, entry, QUEUE_ALIVE_MS)
            .catch(queueDown);
        }
        await this.sleep(QUEUE_POLL_MS);
      }
    } finally {
      clearInterval(refresh);
      if (!queueless) {
        await this.signals.dequeue(key, runId).catch(() => undefined);
      }
    }
  }

  private async tryLease(
    run: RunSpec,
    key: string,
    runId: string,
  ): Promise<{ box: BoxRecord; source: LeaseSource; fresh: boolean } | null> {
    const deadline = new Date(
      this.now() +
        (run.timeoutMs ?? DEFAULT_COMMAND_MS) +
        this.config.deadlineMarginMs,
    );

    // Reuse first: an idle box (already running, so it takes no new slot on
    // the account), else a paused one, else a new box. Resuming and creating
    // both start a VM, so both wait for a slot under the account ceiling.
    let slot: boolean | null = null;
    const hasSlot = async () => (slot ??= await this.takeStartSlot());
    for (let attempt = 0; attempt < 5; attempt++) {
      const at = new Date(this.now());
      let claimed = await this.store.claimReusable(
        key,
        runId,
        { leasedAt: at, heartbeatAt: at, deadline },
        ["idle"],
      );
      if (!claimed && (await hasSlot())) {
        claimed = await this.store.claimReusable(
          key,
          runId,
          { leasedAt: at, heartbeatAt: at, deadline },
          ["paused"],
        );
      }
      if (!claimed) break;
      const { box, from } = claimed;
      this.clearIdleTimer(box.boxId);
      // A resumed box is a new incarnation as far as this process can tell.
      if (from === "paused") this.memos.delete(box.boxId);
      const leased = { state: "leased" as const, leasedBy: runId };
      if (this.retireDue(box)) {
        await this.kill(box, "retired", leased);
        continue;
      }
      // An idle box whose last run succeeded moments ago is alive: that run
      // was the check. Pinging it again cost a round trip on every chunk.
      const warm =
        from === "idle" &&
        !!box.lastOkAt &&
        this.now() - box.lastOkAt.getTime() < this.config.livenessTtlMs;
      if (warm) return { box, source: from, fresh: false };
      if (!(await this.provider.ping(box, this.config.pingTimeoutMs))) {
        this.metrics.failedPing(this.labels(box));
        await this.kill(box, "failed ping", leased);
        continue;
      }
      return { box, source: from, fresh: false };
    }

    if ((await this.store.countLeased(key)) >= this.config.maxPerConnection) {
      return null;
    }
    if (!(await hasSlot())) return null;
    return this.create(run, key, runId, deadline);
  }

  /** The last account count, or the last failure to count, and when. */
  private accountCount: { value: number | null; at: number } | null = null;

  /**
   * Take one slot to start (or resume) a connector box, leaving `appReserve`
   * slots of the account for app sessions.
   *
   * Two numbers decide it. The provider's count of running boxes, app
   * sessions included, read at most once per `accountCountTtlMs` per
   * instance (a failure is remembered as long, and counts as full). And a
   * ledger, shared by every API instance, of connector box starts in the
   * last `accountCountTtlMs + 10 s`: starts the count may not show yet.
   * The ledger update is atomic, so instances never share out the same slot.
   */
  private async takeStartSlot(): Promise<boolean> {
    const limit = this.config.accountCeiling - this.config.appReserve;
    const at = this.now();
    if (
      !this.accountCount ||
      at - this.accountCount.at >= this.config.accountCountTtlMs
    ) {
      try {
        const value = await this.provider.countRunning();
        // No shared account (local provider): no ceiling.
        if (value === null) return true;
        this.accountCount = { value, at };
      } catch (error) {
        logger.warn("Could not count running boxes on the account", {
          error: message(error),
        });
        this.accountCount = { value: null, at };
      }
    }
    const running = this.accountCount.value;
    if (running === null) return false;
    const allowed = limit - running;
    const claimed =
      allowed > 0 &&
      (await this.store.claimStartSlot(
        new Date(at),
        this.config.accountCountTtlMs + 10_000,
        allowed,
      ));
    if (!claimed) this.metrics.ceilingReached?.({ running, limit });
    return claimed;
  }

  private async create(
    run: RunSpec,
    key: string,
    runId: string,
    deadline: Date,
  ): Promise<{ box: BoxRecord; source: LeaseSource; fresh: boolean } | null> {
    const templateKey =
      this.config.snapshots && run.runtimeId
        ? templateKeyOf(key, run.runtimeId)
        : null;
    let template = templateKey
      ? await this.store.getTemplate(templateKey)
      : null;
    const at = new Date(this.now());
    const box: BoxRecord = {
      boxId: `cbx_${randomBytes(10).toString("hex")}`,
      key,
      workspaceId: run.workspaceId,
      connectionId: run.connectionId,
      bundleHash: run.bundleHash,
      state: "leased",
      leasedBy: runId,
      leasedAt: at,
      heartbeatAt: at,
      deadline,
      createdAt: at,
      lastUsedAt: at,
      priorUseAt: await this.store.latestUse(run.connectionId),
      failures: 0,
      runs: 0,
      boxSeconds: 0,
      draining: run.oneOff === true,
      runtimeId: null,
      fromTemplate: template?.snapshotId ?? null,
      stateChangedAt: at,
      killedAt: null,
      killReason: null,
    };
    // Recorded BEFORE the provider is asked: if this process dies in between,
    // the record's heartbeat stops and the reaper kills whatever was made.
    await this.store.insert(box);
    const leased = { state: "leased" as const, leasedBy: runId };
    // The cap check above and this insert are not one operation, and several
    // instances may race here when the queue is down: re-count now that the
    // record exists, and back off if this box broke the cap.
    if ((await this.store.countLeased(key)) > this.config.maxPerConnection) {
      await this.store.transition(box.boxId, leased, {
        state: "killed",
        killedAt: at,
        killReason: "over the per-connection cap",
        leasedBy: null,
      });
      return null;
    }
    try {
      try {
        await this.provider.lease(box, {
          template: template?.snapshotId ?? undefined,
        });
      } catch (error) {
        if (!template || !templateKey) throw error;
        // A template that will not restore is gone or broken: forget it and
        // start from the base template.
        logger.warn("Connector box template did not restore; starting fresh", {
          templateKey,
          snapshotId: template.snapshotId,
          error: message(error),
        });
        await this.store.deleteTemplate(templateKey);
        await this.discardSnapshot(templateKey, template.snapshotId as string);
        await this.store.transition(box.boxId, leased, { fromTemplate: null });
        template = null;
        await this.provider.lease(box, {});
      }
      if (template && templateKey) {
        await this.store.touchTemplate(templateKey, at);
      }
      if (!(await this.provider.ping(box, this.config.pingTimeoutMs))) {
        this.metrics.failedPing(this.labels(box));
        throw new Error("A new connector box did not answer its first ping.");
      }
    } catch (error) {
      await this.kill(box, "failed to start", leased);
      throw error;
    }
    return { box, source: template ? "template" : "fresh", fresh: true };
  }

  private async heartbeat(held: Held): Promise<void> {
    const at = this.now();
    try {
      await this.signals.beat(
        held.box.boxId,
        at,
        this.config.heartbeatTimeoutMs * 2,
      );
    } catch (error) {
      logger.warn("Connector box heartbeat (fast path) failed", {
        boxId: held.box.boxId,
        error: message(error),
      });
    }
    // Always durable too: losing or flushing Redis must never make a live
    // lease look dead to the reaper.
    try {
      await this.store.transition(
        held.box.boxId,
        { state: "leased", leasedBy: held.runId },
        { heartbeatAt: new Date(at) },
      );
    } catch (error) {
      logger.warn("Connector box heartbeat failed", {
        boxId: held.box.boxId,
        error: message(error),
      });
    }
  }

  /** End a lease. The box goes idle, or dies if it is draining or retired. */
  async release(held: Held, failure: string | null): Promise<void> {
    if (held.unhealthy) {
      await this.signals.forget(held.box.boxId).catch(() => undefined);
      this.metrics.boxSeconds(
        Math.max(
          0,
          (this.now() - (held.box.leasedAt?.getTime() ?? this.now())) / 1000,
        ),
        this.labels(held.box),
      );
      await this.kill(held.box, `unhealthy: ${held.unhealthy.slice(0, 200)}`, {
        state: "leased",
        leasedBy: held.runId,
      });
      return;
    }
    const at = this.now();
    const seconds = Math.max(
      0,
      (at - (held.box.leasedAt?.getTime() ?? at)) / 1000,
    );
    const updated = await this.store.transition(
      held.box.boxId,
      { state: "leased", leasedBy: held.runId },
      {
        state: "idle",
        leasedBy: null,
        leasedAt: null,
        deadline: null,
        heartbeatAt: new Date(at),
        lastUsedAt: new Date(at),
        priorUseAt: held.fresh ? held.box.priorUseAt : held.box.lastUsedAt,
        ...(failure ? {} : { lastOkAt: new Date(at) }),
        ...(held.runtimeId ? { runtimeId: held.runtimeId } : {}),
      },
      { runs: 1, failures: failure ? 1 : 0, boxSeconds: seconds },
    );
    await this.signals.forget(held.box.boxId).catch(() => undefined);
    this.metrics.boxSeconds(seconds, this.labels(held.box));
    if (failure) {
      logger.info("Connector run failed in its box", {
        boxId: held.box.boxId,
        failure: failure.slice(0, 300),
      });
    }
    // Null: the reaper took the box while the run was in it. Nothing to do.
    if (!updated) return;
    const idle = {
      state: "idle" as const,
      leasedBy: null,
      lastUsedAt: updated.lastUsedAt,
    };
    if (updated.draining) {
      await this.kill(updated, "drained", idle);
      return;
    }
    if (this.retireDue(updated)) {
      await this.kill(updated, "retired", idle);
      return;
    }
    this.scheduleIdlePause(updated);
  }

  private retireDue(box: BoxRecord): boolean {
    return (
      box.failures >= this.config.maxFailures ||
      this.now() - box.createdAt.getTime() >= this.config.maxAgeMs
    );
  }

  /** TTL of a paused box: long for a connection that runs daily, else short. */
  ttlOf(box: BoxRecord): number {
    const recent =
      box.priorUseAt !== null &&
      box.lastUsedAt.getTime() - box.priorUseAt.getTime() <=
        this.config.recentWindowMs;
    return recent ? this.config.ttlRecentMs : this.config.ttlStaleMs;
  }

  /**
   * Pause a box the moment it has been idle long enough, from this process.
   * The reaper does the same every minute; this only makes it prompt.
   */
  private scheduleIdlePause(box: BoxRecord): void {
    this.clearIdleTimer(box.boxId);
    const timer = setTimeout(() => {
      this.idleTimers.delete(box.boxId);
      void this.pauseIfIdle(box).catch(error =>
        logger.warn("Could not pause an idle connector box", {
          boxId: box.boxId,
          error: message(error),
        }),
      );
    }, this.config.idlePauseMs);
    timer.unref?.();
    this.idleTimers.set(box.boxId, timer);
  }

  private clearIdleTimer(boxId: string): void {
    const timer = this.idleTimers.get(boxId);
    if (timer) clearTimeout(timer);
    this.idleTimers.delete(boxId);
  }

  /**
   * idle -> pausing -> paused, if the box has not been used since `box` was
   * read. Snapshots the box first when its key has no template yet.
   */
  async pauseIfIdle(box: BoxRecord): Promise<boolean> {
    const claimed = await this.store.transition(
      box.boxId,
      {
        state: "idle",
        leasedBy: null,
        lastUsedAt: box.lastUsedAt,
        draining: false,
      },
      { state: "pausing" },
    );
    if (!claimed) {
      // A box drained during its idle window dies instead of pausing.
      await this.kill(box, "drained", {
        state: "idle",
        leasedBy: null,
        lastUsedAt: box.lastUsedAt,
        draining: true,
      });
      return false;
    }
    try {
      await this.provider.pause(claimed);
      await this.store.transition(
        claimed.boxId,
        { state: "pausing" },
        { state: "paused" },
      );
      return true;
    } catch (error) {
      // A box that will not pause is not trusted to resume either.
      logger.warn("Connector box did not pause; killing it", {
        boxId: claimed.boxId,
        error: message(error),
      });
      await this.kill(claimed, "pause failed", { state: "pausing" });
      return false;
    }
  }

  /**
   * Snapshot a fresh box as its key's template (see BoxLease.snapshotPristine).
   *
   * One box per key wins the claim; nobody replaces a template, so no
   * snapshot is ever orphaned by a race. A failed snapshot drops the claim.
   */
  private async snapshotPristine(held: Held, runtimeId: string): Promise<void> {
    if (
      !this.config.snapshots ||
      !held.fresh ||
      held.box.fromTemplate ||
      held.run.oneOff
    ) {
      return;
    }
    const templateKey = templateKeyOf(held.key, runtimeId);
    const at = new Date(this.now());
    if (!(await this.store.claimTemplate(templateKey, at))) return;
    let snapshotId: string | null = null;
    try {
      snapshotId = await this.provider.snapshot(
        held.box,
        snapshotName(templateKey),
      );
      if (!snapshotId) {
        await this.store.deleteTemplate(templateKey);
        return;
      }
      if (!(await this.store.completeTemplate(templateKey, snapshotId))) {
        // The claim expired or was deleted while the snapshot ran: nobody
        // will ever restore or delete this snapshot unless we do.
        await this.discardSnapshot(templateKey, snapshotId);
      }
    } catch (error) {
      await this.store.deleteTemplate(templateKey).catch(() => undefined);
      if (snapshotId) await this.discardSnapshot(templateKey, snapshotId);
      logger.warn("Could not snapshot a connector box; continuing without", {
        boxId: held.box.boxId,
        error: message(error),
      });
    }
  }

  /**
   * Delete a snapshot no template points to. If the delete fails, park it
   * under a dead key no lease looks up, already stale, so the reaper's
   * template sweep retries the delete until it succeeds.
   */
  private async discardSnapshot(
    templateKey: string,
    snapshotId: string,
  ): Promise<void> {
    try {
      await this.provider.deleteSnapshot(snapshotId);
    } catch (error) {
      const dead = `${templateKey}#dead:${snapshotId}`;
      const epoch = new Date(0);
      logger.warn("Could not delete a connector box snapshot; will retry", {
        snapshotId,
        error: message(error),
      });
      await this.store.claimTemplate(dead, epoch).catch(() => false);
      await this.store.completeTemplate(dead, snapshotId).catch(() => false);
      await this.store.touchTemplate(dead, epoch).catch(() => undefined);
    }
  }

  /**
   * A connection was deleted or its credential changed: its boxes drain and
   * die at the next sweep, and its snapshot templates are deleted.
   */
  async forgetConnection(connectionId: string): Promise<void> {
    await this.store.drainConnection(connectionId);
    for (const template of await this.store.templatesOfConnection(
      connectionId,
    )) {
      if (template.snapshotId) {
        await this.provider.deleteSnapshot(template.snapshotId);
      }
      await this.store.deleteTemplate(template.templateKey);
    }
  }

  /** Claim the box for killing, kill it, record it. False if someone else won. */
  private async kill(
    box: BoxRecord,
    reason: string,
    expect: BoxExpect,
  ): Promise<boolean> {
    const claimed = await this.store.transition(box.boxId, expect, {
      state: "killing",
      killReason: reason,
    });
    if (!claimed) return false;
    this.clearIdleTimer(box.boxId);
    this.memos.delete(box.boxId);
    try {
      await this.provider.kill(box);
    } catch (error) {
      // Left in `killing`: the reaper tries again.
      logger.warn("Could not kill a connector box; will retry", {
        boxId: box.boxId,
        reason,
        error: message(error),
      });
      return false;
    }
    await this.store.transition(
      box.boxId,
      { state: "killing" },
      {
        state: "killed",
        killedAt: new Date(this.now()),
        leasedBy: null,
        deadline: null,
      },
    );
    await this.signals.forget(box.boxId).catch(() => undefined);
    this.metrics.reaped(reason, this.labels(box));
    return true;
  }

  /**
   * One sweep: kill dead leases, pause idle boxes, enforce TTLs, retire old
   * boxes, delete unused templates, and report box counts per state.
   */
  async reap(): Promise<ReapSummary> {
    const at = this.now();
    const summary: ReapSummary = {
      killed: {},
      paused: 0,
      templatesDeleted: 0,
      counts: emptyCounts(),
    };
    const killed = async (
      box: BoxRecord,
      reason: string,
      expect: BoxExpect,
    ) => {
      if (await this.kill(box, reason, expect)) {
        summary.killed[reason] = (summary.killed[reason] ?? 0) + 1;
      }
    };

    const live = await this.store.listLive();
    // Unreadable beats are not stale beats: without them the reaper still
    // enforces deadlines, but kills nothing for heartbeat age.
    const beats = await this.signals
      .lastBeats(live.filter(b => b.state === "leased").map(b => b.boxId))
      .catch(error => {
        logger.warn("Could not read connector box heartbeats", {
          error: message(error),
        });
        return null;
      });

    for (const box of live) {
      try {
        switch (box.state) {
          case "leased": {
            const expect = { state: "leased" as const, leasedBy: box.leasedBy };
            const lastBeat = Math.max(
              beats?.get(box.boxId) ?? 0,
              box.heartbeatAt?.getTime() ?? 0,
            );
            if (box.deadline && box.deadline.getTime() < at) {
              await killed(box, "lease expired", expect);
            } else if (
              beats &&
              at - lastBeat > this.config.heartbeatTimeoutMs
            ) {
              await killed(box, "heartbeat stopped", expect);
            }
            break;
          }
          case "idle": {
            const expect = {
              state: "idle" as const,
              leasedBy: null,
              lastUsedAt: box.lastUsedAt,
            };
            if (box.draining) await killed(box, "drained", expect);
            else if (this.retireDue(box)) await killed(box, "retired", expect);
            else if (at - box.lastUsedAt.getTime() >= this.config.idlePauseMs) {
              if (await this.pauseIfIdle(box)) summary.paused++;
            }
            break;
          }
          case "paused": {
            const expect = {
              state: "paused" as const,
              leasedBy: null,
              lastUsedAt: box.lastUsedAt,
            };
            if (box.draining) await killed(box, "drained", expect);
            else if (this.retireDue(box)) await killed(box, "retired", expect);
            else if (at - box.lastUsedAt.getTime() >= this.ttlOf(box)) {
              await killed(box, "ttl", expect);
            }
            break;
          }
          case "pausing":
          case "killing": {
            if (at - box.stateChangedAt.getTime() >= STUCK_TRANSITION_MS) {
              await killed(box, box.killReason ?? `stuck ${box.state}`, {
                state: box.state,
              });
            }
            break;
          }
          default:
            break;
        }
      } catch (error) {
        logger.warn("Connector box reaper skipped a box", {
          boxId: box.boxId,
          error: message(error),
        });
      }
    }

    for (const template of await this.store.staleTemplates(
      new Date(at - this.config.templateTtlMs),
      new Date(at - TEMPLATE_CLAIM_MS),
    )) {
      try {
        if (template.snapshotId) {
          await this.provider.deleteSnapshot(template.snapshotId);
        }
        await this.store.deleteTemplate(template.templateKey);
        summary.templatesDeleted++;
      } catch (error) {
        logger.warn("Could not delete a connector box template", {
          templateKey: template.templateKey,
          error: message(error),
        });
      }
    }

    for (const box of await this.store.listLive()) {
      summary.counts[box.state]++;
    }
    this.metrics.boxCounts(summary.counts);
    return summary;
  }

  private labels(box: BoxRecord) {
    return {
      workspaceId: box.workspaceId,
      connectionId: box.connectionId,
      boxId: box.boxId,
    };
  }
}

function emptyCounts(): Record<BoxState, number> {
  return {
    leased: 0,
    idle: 0,
    pausing: 0,
    paused: 0,
    killing: 0,
    killed: 0,
  };
}

let scheduler: BoxScheduler | null = null;

/** The process-wide scheduler: Mongo records, Redis signals, the sandbox provider. */
export function getBoxScheduler(): BoxScheduler {
  scheduler ??= new BoxScheduler({
    store: new MongoBoxStore(),
    signals: getBoxSignals(),
    provider: sandboxBoxProvider,
  });
  return scheduler;
}

/**
 * A connection was deleted or its credential changed. Fire-and-forget: a
 * failure is logged, and the reaper still kills the boxes on their TTL.
 * A no-op when leases are off and no box was ever recorded.
 */
export function forgetConnectionBoxes(connectionId: string): void {
  void getBoxScheduler()
    .forgetConnection(connectionId)
    .catch(error =>
      logger.warn("Could not forget a connection's connector boxes", {
        connectionId,
        error: message(error),
      }),
    );
}

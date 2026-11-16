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
import type { SandboxExecContext } from "../../../apps/sandbox/provider";
import { loggers } from "../../../logging";
import {
  boxContext,
  sandboxBoxProvider,
  type BoxProvider,
} from "./box-provider";
import { getBoxSignals, type BoxSignals } from "./box-signals";
import {
  MongoBoxStore,
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
  /** Record the runtime the box now holds, for its snapshot template. */
  noteRuntime(runtimeId: string): void;
}

interface Held {
  run: RunSpec;
  key: string;
  runId: string;
  box: BoxRecord;
  fresh: boolean;
  runtimeId: string | null;
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
      noteRuntime: runtimeId => {
        held.runtimeId = runtimeId;
      },
    };
    try {
      return await fn(lease);
    } catch (error) {
      failure ??= message(error);
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
    const aliveMs = Math.max(20 * QUEUE_POLL_MS, 5_000);

    // A new hash for this connection: its older boxes drain and die.
    if (!run.oneOff) {
      await this.store.drainOtherHashes(run.connectionId, run.bundleHash);
    }

    await this.signals.enqueue(
      key,
      {
        runId,
        priority: run.priority ?? DEFAULT_RUN_PRIORITY,
        enqueuedAt: started,
      },
      aliveMs,
    );
    let queued = false;
    try {
      for (;;) {
        if (await this.signals.isHead(key, runId)) {
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
            };
          }
        }
        if (this.now() - started >= this.config.queueWaitMs) {
          const depth = await this.signals.depth(key).catch(() => -1);
          throw new Error(
            `No connector box for this connection after ${Math.round(this.config.queueWaitMs / 1000)} s. ` +
              `${depth >= 0 ? `${depth} runs are waiting; ` : ""}` +
              `At most ${this.config.maxPerConnection} boxes run per connection, and connector boxes ` +
              `stop at ${this.config.accountCeiling - this.config.appReserve} running boxes on the account, app sessions included.`,
          );
        }
        queued = true;
        await this.signals.touch(key, runId, aliveMs);
        await this.sleep(QUEUE_POLL_MS);
      }
    } finally {
      await this.signals.dequeue(key, runId).catch(() => undefined);
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
    const hasSlot = async () => (slot ??= await this.accountSlotFree());
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
      const leased = { state: "leased" as const, leasedBy: runId };
      if (this.retireDue(box)) {
        await this.kill(box, "retired", leased);
        continue;
      }
      if (!(await this.provider.ping(box, this.config.pingTimeoutMs))) {
        this.metrics.failedPing(this.labels(box));
        await this.kill(box, "failed ping", leased);
        continue;
      }
      if (from === "paused") this.noteStarted();
      return { box, source: from, fresh: false };
    }

    if ((await this.store.countLeased(key)) >= this.config.maxPerConnection) {
      return null;
    }
    if (!(await hasSlot())) return null;
    const created = await this.create(run, key, runId, deadline);
    this.noteStarted();
    return created;
  }

  private accountCount: { value: number; at: number } | null = null;

  /**
   * Is there room on the provider account for one more running box, leaving
   * `appReserve` slots for app sessions? The count is the whole account's,
   * app sessions included, because they share one concurrency limit.
   * Unknown (the provider could not answer) counts as full: a connector run
   * waits rather than take the slot an app preview needs.
   */
  private async accountSlotFree(): Promise<boolean> {
    const limit = this.config.accountCeiling - this.config.appReserve;
    const at = this.now();
    if (
      !this.accountCount ||
      at - this.accountCount.at >= this.config.accountCountTtlMs
    ) {
      let value: number | null;
      try {
        value = await this.provider.countRunning();
      } catch (error) {
        logger.warn("Could not count running boxes on the account", {
          error: message(error),
        });
        this.accountCount = null;
        return false;
      }
      // No shared account (local provider): no ceiling.
      if (value === null) return true;
      this.accountCount = { value, at };
    }
    const free = this.accountCount.value < limit;
    if (!free) {
      this.metrics.ceilingReached?.({
        running: this.accountCount.value,
        limit,
      });
    }
    return free;
  }

  /** Count a box this process just started until the next real count. */
  private noteStarted(): void {
    if (this.accountCount) this.accountCount.value++;
  }

  private async create(
    run: RunSpec,
    key: string,
    runId: string,
    deadline: Date,
  ): Promise<{ box: BoxRecord; source: LeaseSource; fresh: boolean }> {
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
    try {
      try {
        await this.provider.lease(box, { template: template?.snapshotId });
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
      // The in-process fallback is invisible to other API instances, so the
      // durable record carries the beat too.
      if (this.signals.kind === "memory") {
        await this.store.transition(
          held.box.boxId,
          { state: "leased", leasedBy: held.runId },
          { heartbeatAt: new Date(at) },
        );
      }
    } catch (error) {
      logger.warn("Connector box heartbeat failed", {
        boxId: held.box.boxId,
        error: message(error),
      });
    }
  }

  /** End a lease. The box goes idle, or dies if it is draining or retired. */
  async release(held: Held, failure: string | null): Promise<void> {
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
      { state: "idle", leasedBy: null, lastUsedAt: box.lastUsedAt },
      { state: "pausing" },
    );
    if (!claimed) return false;
    try {
      await this.ensureTemplate(claimed);
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
   * Snapshot a box that is about to pause, once per template key.
   *
   * Taken while no run is in the box: run directories and run users are
   * gone, so the snapshot holds no credential. The template is per key
   * (connection plus hash plus runtime), so nothing a connector left on
   * disk ever reaches another connection's box.
   */
  private async ensureTemplate(box: BoxRecord): Promise<void> {
    if (!this.config.snapshots || !box.runtimeId) return;
    const templateKey = templateKeyOf(box.key, box.runtimeId);
    if (await this.store.getTemplate(templateKey)) return;
    try {
      const snapshotId = await this.provider.snapshot(
        box,
        snapshotName(templateKey),
      );
      if (!snapshotId) return;
      const at = new Date(this.now());
      await this.store.putTemplate({
        templateKey,
        snapshotId,
        createdAt: at,
        lastUsedAt: at,
      });
    } catch (error) {
      logger.warn("Could not snapshot a connector box; it will still pause", {
        boxId: box.boxId,
        error: message(error),
      });
    }
  }

  /** Claim the box for killing, kill it, record it. False if someone else won. */
  private async kill(
    box: BoxRecord,
    reason: string,
    expect: Partial<Pick<BoxRecord, "state" | "leasedBy" | "lastUsedAt">>,
  ): Promise<boolean> {
    const claimed = await this.store.transition(box.boxId, expect, {
      state: "killing",
      killReason: reason,
    });
    if (!claimed) return false;
    this.clearIdleTimer(box.boxId);
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
      expect: Partial<Pick<BoxRecord, "state" | "leasedBy" | "lastUsedAt">>,
    ) => {
      if (await this.kill(box, reason, expect)) {
        summary.killed[reason] = (summary.killed[reason] ?? 0) + 1;
      }
    };

    const live = await this.store.listLive();
    const beats = await this.signals
      .lastBeats(live.filter(b => b.state === "leased").map(b => b.boxId))
      .catch(error => {
        logger.warn("Could not read connector box heartbeats", {
          error: message(error),
        });
        return new Map<string, number>();
      });

    for (const box of live) {
      try {
        switch (box.state) {
          case "leased": {
            const expect = { state: "leased" as const, leasedBy: box.leasedBy };
            const lastBeat = Math.max(
              beats.get(box.boxId) ?? 0,
              box.heartbeatAt?.getTime() ?? 0,
            );
            if (box.deadline && box.deadline.getTime() < at) {
              await killed(box, "lease expired", expect);
            } else if (at - lastBeat > this.config.heartbeatTimeoutMs) {
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
    )) {
      try {
        await this.provider.deleteSnapshot(template.snapshotId);
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

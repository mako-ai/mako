/**
 * ExecutionEngine — the engine seam, from outside a run.
 *
 *   enqueue(runId)       make the run progress (start, or retry)
 *   signal(runId, key)   a wait inside the run may now be satisfied
 *   cancel(runId)        stop executing (status is already set by the service)
 *
 * Production: Inngest (`inngest-engine.ts`). Tests and engine-less dev:
 * LocalEngine, which re-executes the run in-process.
 */
import { loggers } from "../../logging";
import { executeRun, type ExecuteOutcome } from "./executor";
import { LocalDriver, Suspend } from "./driver";

const log = loggers.inngest("processes");

export interface ExecutionEngine {
  readonly name: string;
  enqueue(runId: string, meta: { workspaceId: string }): Promise<void>;
  signal(runId: string, key: string): Promise<void>;
  cancel(runId: string): Promise<void>;
}

let engine: ExecutionEngine | null = null;

export function setExecutionEngine(next: ExecutionEngine): void {
  engine = next;
}

export function getExecutionEngine(): ExecutionEngine {
  if (!engine) throw new Error("Process execution engine is not configured");
  return engine;
}

/**
 * In-process engine. Executions of one run are serialized; a run that
 * suspends on a timer is re-executed when the timer fires (non-durable — a
 * restart forgets timers, which is why production uses Inngest).
 */
export class LocalEngine implements ExecutionEngine {
  readonly name = "local";
  private chains = new Map<string, Promise<unknown>>();
  private timers = new Map<string, NodeJS.Timeout>();
  readonly outcomes = new Map<string, ExecuteOutcome>();

  constructor(
    private readonly options: {
      now?: () => Date;
      backoffMs?: number;
      /** Tests drive time themselves; dev uses real timers. */
      timers?: boolean;
    } = {},
  ) {}

  private execute(runId: string): Promise<unknown> {
    const previous = this.chains.get(runId) ?? Promise.resolve();
    const next = previous
      .catch(() => undefined)
      .then(async () => {
        try {
          const outcome = await executeRun(
            runId,
            new LocalDriver({
              now: this.options.now,
              backoffMs: this.options.backoffMs,
            }),
          );
          this.outcomes.set(runId, outcome);
        } catch (error) {
          if (error instanceof Suspend) {
            this.outcomes.set(runId, "suspended");
            if (error.wakeAt && this.options.timers !== false) {
              this.schedule(runId, error.wakeAt);
            }
            return;
          }
          log.error("Local process execution crashed", { runId, error });
          throw error;
        }
      });
    this.chains.set(runId, next);
    return next;
  }

  private schedule(runId: string, at: Date): void {
    const existing = this.timers.get(runId);
    if (existing) clearTimeout(existing);
    const delay = Math.max(0, at.getTime() - Date.now());
    const timer = setTimeout(
      () => {
        this.timers.delete(runId);
        void this.execute(runId);
      },
      Math.min(delay, 2 ** 31 - 1),
    );
    timer.unref?.();
    this.timers.set(runId, timer);
  }

  async enqueue(runId: string): Promise<void> {
    void this.execute(runId);
  }

  async signal(runId: string): Promise<void> {
    void this.execute(runId);
  }

  async cancel(runId: string): Promise<void> {
    const timer = this.timers.get(runId);
    if (timer) clearTimeout(timer);
    this.timers.delete(runId);
  }

  /** Re-execute now (tests: after advancing the clock past a deadline). */
  wake(runId: string): Promise<unknown> {
    return this.execute(runId);
  }

  /** Wait until every scheduled execution has settled. */
  async idle(): Promise<void> {
    let pending = [...this.chains.values()];
    while (pending.length) {
      await Promise.allSettled(pending);
      const now = [...this.chains.values()];
      if (now.every(p => pending.includes(p))) return;
      pending = now;
    }
  }
}

/**
 * Inngest adapter: the production ExecutionEngine + Driver.
 *
 *   ExecutionEngine  → events: process/run.requested, process/signal,
 *                      process/run.cancel
 *   Driver           → step.run / step.sleepUntil / step.waitForEvent
 *
 * Inngest provides scheduling, waking, per-step retries and memoization within
 * one Inngest run. Everything durable is ALSO in our journal, so swapping this
 * file for a Hatchet/Temporal adapter changes no process code.
 */
import { NonRetriableError } from "inngest";
import { inngest } from "../../inngest/client";
import {
  isNonRetryable,
  type Driver,
  type RunOptions,
  type WaitForSignalOptions,
} from "./driver";
import { errorMessage } from "./journal";
import type { ExecutionEngine } from "./engine";

export const PROCESS_EVENTS = {
  runRequested: "process/run.requested",
  signal: "process/signal",
  cancel: "process/run.cancel",
} as const;

/** Function-level retries = the most any single step may use. */
export const MAX_STEP_RETRIES = 5;

export class InngestEngine implements ExecutionEngine {
  readonly name = "inngest";

  async enqueue(runId: string, meta: { workspaceId: string }): Promise<void> {
    await inngest.send({
      name: PROCESS_EVENTS.runRequested,
      data: { runId, workspaceId: meta.workspaceId },
    });
  }

  async signal(runId: string, key: string): Promise<void> {
    await inngest.send({
      name: PROCESS_EVENTS.signal,
      data: { runId, key },
    });
  }

  async cancel(runId: string): Promise<void> {
    await inngest.send({ name: PROCESS_EVENTS.cancel, data: { runId } });
  }
}

// Minimal structural type for the step tools we use, so this file does not
// depend on Inngest's generic handler types.
interface InngestStepTools {
  run<T>(id: string, fn: () => Promise<T>): Promise<unknown>;
  sleepUntil(id: string, until: Date): Promise<void>;
  waitForEvent(
    id: string,
    opts: { event: string; timeout: Date; if: string },
  ): Promise<unknown>;
}

function celString(value: string): string {
  return JSON.stringify(value);
}

export class InngestDriver implements Driver {
  readonly engine = "inngest";

  constructor(
    private readonly step: InngestStepTools,
    private readonly attempt: number,
    private readonly runId: string,
  ) {}

  async run<T>(
    id: string,
    fn: (attempt: number) => Promise<T>,
    options: RunOptions,
  ): Promise<T> {
    const retries = Math.min(options.retries, MAX_STEP_RETRIES);
    const result = await this.step.run(id, async () => {
      try {
        // Boxed so null and undefined survive serialization distinctly.
        return { v: await fn(this.attempt) };
      } catch (error) {
        if (isNonRetryable(error) || this.attempt >= retries) {
          throw new NonRetriableError(errorMessage(error), { cause: error });
        }
        throw error;
      }
    });
    return (result as { v?: T } | null)?.v as T;
  }

  async sleepUntil(id: string, until: Date): Promise<void> {
    // Always emit the step (even for a past deadline): skipping it based on
    // the wall clock would make replays disagree about which steps exist.
    await this.step.sleepUntil(id, until);
  }

  async waitForSignal<T>(
    id: string,
    options: WaitForSignalOptions<T>,
  ): Promise<T | null> {
    const ready = (await this.step.run(
      `${id}:check`,
      async () => (await options.check()) ?? null,
    )) as T | null;
    if (ready !== null) return ready;
    // A signal sent between the check and this wait registering is missed by
    // waitForEvent (no lookback); the redelivery function re-sends every
    // signal ~20s later, and the final read below catches anything else.
    await this.step.waitForEvent(`${id}:signal`, {
      event: PROCESS_EVENTS.signal,
      timeout: new Date(
        Math.max(options.timeoutAt.getTime(), Date.now() + 1_000),
      ),
      if: `async.data.runId == ${celString(this.runId)} && async.data.key == ${celString(options.signalKey)}`,
    });
    return (await this.step.run(
      `${id}:read`,
      async () => (await options.check()) ?? null,
    )) as T | null;
  }
}

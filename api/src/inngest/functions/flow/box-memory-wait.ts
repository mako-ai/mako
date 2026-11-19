/**
 * A flow step that waits for box memory instead of failing.
 *
 * Many flow steps share one connector box, and nothing else caps how many
 * run in it at once. The box's memory gate (run-isolation.ts
 * memoryGateScript, first in every chunk run and session start) refuses a
 * new run when the box has less than CONNECTOR_RUN_MIN_FREE_MB free. This turns that refusal into a durable
 * sleep and a fresh attempt, so free memory is the concurrency cap: a step
 * starts only when the runs before it have ended. Any cron or flow that runs
 * its connector work through it can never overfill a box.
 *
 * The refusal never uses an Inngest retry and never fails the run: the step
 * returns a marker, the function sleeps (step.sleep), and the next attempt
 * runs under a new step id. Only after MAX waits does the refusal throw, and
 * then infra-failure.ts reads it as Mako's failure, never the connector's.
 * A step that must never throw (a webhook batch, a CDC materialization)
 * passes `giveUp` and returns a "come back later" result instead.
 *
 * A wrapped refusal counts too: schema resolution wraps it in
 * SchemaResolutionError (box-memory.ts boxLowMemoryRefusal).
 */
import {
  boxLowMemoryRefusal,
  type BoxLowMemoryError,
} from "../../../apps/sandbox/box-memory";

/** Wait before the next attempt: 60 s, plus up to 30 s so waiters spread out. */
export const BOX_MEMORY_WAIT_MS = 60_000;
export const BOX_MEMORY_WAIT_JITTER_MS = 30_000;
/**
 * Waits before the refusal throws: about 20 to 30 min. Each wait costs 2
 * steps, so 20 waits stay well inside sync-entity's 100-step headroom under
 * Inngest's 1,000-step limit.
 */
export const BOX_MEMORY_MAX_WAITS = 20;

/** What a refused attempt returns in place of its result. */
const MARKER = "__boxLowMemory";

interface Refusal {
  [MARKER]: { message: string; availableMb: number | null; retryInMs: number };
}

function isRefusal(value: unknown): value is Refusal {
  return typeof value === "object" && value !== null && MARKER in value;
}

/** The two Inngest step tools this needs. */
export interface BoxMemoryWaitStep {
  run: (id: string, fn: () => Promise<unknown>) => Promise<unknown>;
  sleep: (id: string, durationMs: number) => Promise<unknown>;
}

/**
 * Run `fn` as the step `id`. When a box memory gate refuses it, sleep and run
 * it again as `<id>-after-memory-wait-<n>`. The first attempt keeps `id`
 * unchanged, so runs already in flight replay as before.
 *
 * Returns the step's result and how many waits it took (2 steps each).
 */
export async function withBoxMemoryWaits<T>(
  step: BoxMemoryWaitStep,
  id: string,
  fn: () => Promise<T>,
  options: {
    maxWaits?: number;
    onWait?: (wait: number, refusal: Refusal[typeof MARKER]) => void;
    /**
     * Runs inside the step once the waits are used up. Its value becomes the
     * step's result, and the refusal does not throw.
     */
    giveUp?: (refusal: BoxLowMemoryError) => T;
    random?: () => number;
  } = {},
): Promise<{ result: T; waits: number }> {
  const maxWaits = options.maxWaits ?? BOX_MEMORY_MAX_WAITS;
  const random = options.random ?? Math.random;
  for (let wait = 0; ; wait++) {
    const stepId = wait === 0 ? id : `${id}-after-memory-wait-${wait}`;
    const outcome = await step.run(stepId, async () => {
      try {
        return await fn();
      } catch (error) {
        const refused = boxLowMemoryRefusal(error);
        if (!refused) throw error;
        if (wait >= maxWaits) {
          if (options.giveUp) return options.giveUp(refused);
          throw error;
        }
        const refusal: Refusal = {
          [MARKER]: {
            message: refused.message,
            availableMb: refused.availableMb,
            // Inside the step, so a replay sleeps exactly as long.
            retryInMs:
              BOX_MEMORY_WAIT_MS +
              Math.floor(random() * BOX_MEMORY_WAIT_JITTER_MS),
          },
        };
        // Inside the step: a replay does not log the wait again.
        options.onWait?.(wait + 1, refusal[MARKER]);
        return refusal;
      }
    });
    if (!isRefusal(outcome)) return { result: outcome as T, waits: wait };
    await step.sleep(
      `${id}-memory-wait-${wait + 1}`,
      outcome[MARKER].retryInMs,
    );
  }
}

/**
 * The execution-engine seam, from inside a run.
 *
 * Three operations are all the process runtime needs from a durable engine:
 *
 *   run(id, fn)            execute fn (at least once) and memoize its result
 *   sleepUntil(id, date)   suspend with nothing running until a time
 *   waitForSignal(id, …)   suspend until signalled (or timeout); `check` reads
 *                          the source of truth so a signal sent before the
 *                          wait registered is never lost
 *
 * Because every durable fact is ALSO journaled in Mongo (see journal.ts),
 * a driver only has to provide scheduling, retries and waking. Inngest is the
 * production driver (`inngest-engine.ts`); `LocalDriver` re-executes the run
 * in-process and is used by tests and engine-less development.
 */

export interface RunOptions {
  /** Attempts after the first. */
  retries: number;
}

export interface WaitForSignalOptions<T> {
  /** Unique within the run; the signal must carry the same key. */
  signalKey: string;
  timeoutAt: Date;
  /** Reads the durable state. Non-null = the wait is satisfied. */
  check: () => Promise<T | null>;
}

export interface Driver {
  readonly engine: string;
  run<T>(
    id: string,
    fn: (attempt: number) => Promise<T>,
    options: RunOptions,
  ): Promise<T>;
  sleepUntil(id: string, until: Date): Promise<void>;
  waitForSignal<T>(
    id: string,
    options: WaitForSignalOptions<T>,
  ): Promise<T | null>;
}

/** A step error that must not be retried (validation, cancellation, ledger). */
export class NonRetryableStepError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NonRetryableStepError";
  }
}

/** The run was cancelled while it executed. */
export class RunCancelledError extends NonRetryableStepError {
  constructor() {
    super("Run was cancelled");
    this.name = "RunCancelledError";
  }
}

/** LocalDriver control flow: the run must stop here and be resumed later. */
export class Suspend extends Error {
  constructor(readonly wakeAt: Date | null) {
    super("suspended");
    this.name = "Suspend";
  }
}

export function isNonRetryable(error: unknown): boolean {
  return (
    error instanceof NonRetryableStepError ||
    (error instanceof Error && error.name === "PermanentError")
  );
}

/**
 * In-process driver: steps execute inline (memoization comes from the
 * journal), waits that are not yet satisfied throw `Suspend`. The LocalEngine
 * re-executes the run from the top when a signal or timer arrives — the same
 * replay model as Inngest, minus the durable scheduler.
 */
export class LocalDriver implements Driver {
  readonly engine = "local";

  constructor(
    private readonly options: {
      now?: () => Date;
      /** Backoff between attempts (ms). Tests use 0. */
      backoffMs?: number;
    } = {},
  ) {}

  private now(): Date {
    return this.options.now ? this.options.now() : new Date();
  }

  async run<T>(
    _id: string,
    fn: (attempt: number) => Promise<T>,
    options: RunOptions,
  ): Promise<T> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= options.retries; attempt++) {
      try {
        return await fn(attempt);
      } catch (error) {
        lastError = error;
        if (error instanceof Suspend || isNonRetryable(error)) throw error;
        const backoff = this.options.backoffMs ?? 250 * 2 ** attempt;
        if (backoff > 0 && attempt < options.retries) {
          await new Promise(resolve => setTimeout(resolve, backoff));
        }
      }
    }
    throw lastError;
  }

  async sleepUntil(_id: string, until: Date): Promise<void> {
    if (this.now().getTime() >= until.getTime()) return;
    throw new Suspend(until);
  }

  async waitForSignal<T>(
    _id: string,
    options: WaitForSignalOptions<T>,
  ): Promise<T | null> {
    const value = await options.check();
    if (value !== null) return value;
    if (this.now().getTime() >= options.timeoutAt.getTime()) return null;
    throw new Suspend(options.timeoutAt);
  }
}

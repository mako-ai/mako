/** The caller's deadline refused a command before it started. */
export class LaunchDeadlineError extends Error {
  constructor() {
    super("The command could not start within the caller's deadline.");
    this.name = "LaunchDeadlineError";
  }
}

export function assertLaunchDeadline(remainingMs?: () => number): void {
  if (remainingMs && !(remainingMs() >= 1)) throw new LaunchDeadlineError();
}

/** Cap one launch by the caller's remaining budget, or refuse it. */
export function launchTimeout(
  timeoutMs: number,
  remainingMs: (() => number) | undefined,
  minimumMs: number,
): number | null {
  if (!remainingMs) return timeoutMs;
  const timeout = Math.min(timeoutMs, remainingMs());
  return Number.isFinite(timeout) && timeout >= minimumMs ? timeout : null;
}

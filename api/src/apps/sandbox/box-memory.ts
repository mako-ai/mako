/**
 * Reading a box's free memory, and the error a memory gate throws.
 *
 * Its own module so every box that runs work side by side gates on the same
 * number the same way: the publish box before a build (deployment/build.ts)
 * and the connector boxes before a connector run or a read session
 * (connectors/workspace/run-isolation.ts). Both incidents had the same shape. On
 * 18 Nov 2026 the publish box sat at 2,018 of 2,079 MB for 34 min. On 19 Nov
 * 2026 a workspace's connector sync box reached 1,899 of 1,982 MB, and Mako
 * killed and replaced it 10 times in 2 hours. In both, envd could not start a
 * command before its deadline, so every command failed with deadline_exceeded.
 */

/**
 * Shell that prints `avail <MiB>`: the kernel's MemAvailable, which counts
 * reclaimable page cache as free. Without /proc (macOS, the local provider)
 * it prints nothing, and the gate lets the work through.
 */
export const MEM_AVAILABLE_SCRIPT = `awk '/^MemAvailable:/ { print "avail", int($2 / 1024) }' /proc/meminfo`;

/**
 * Shell that runs `onLow` when the box has under `minFreeMb` MiB of
 * MemAvailable, with the figure in `$avail`. For a gate inside a command
 * that already goes to the box, so the check costs no round trip of its
 * own. Without /proc, `$avail` is empty and `onLow` never runs.
 */
export function memoryGateShell(minFreeMb: number, onLow: string): string {
  if (!Number.isInteger(minFreeMb) || minFreeMb < 0) {
    throw new Error("memoryGateShell: minFreeMb must be a whole number");
  }
  return `avail=$(awk '/^MemAvailable:/ { print int($2 / 1024) }' /proc/meminfo 2>/dev/null)
if [ -n "$avail" ] && [ "$avail" -lt ${minFreeMb} ]; then
${onLow}
fi`;
}

/** MemAvailable in MiB from MEM_AVAILABLE_SCRIPT's output, or null if unreadable. */
export function parseAvailableMb(stdout: string): number | null {
  const match = /^avail (\d+)$/m.exec(stdout);
  return match ? Number(match[1]) : null;
}

/**
 * A box has too little free memory to start more work. Retriable by
 * construction: the work in the box ends and frees its memory. Callers retry
 * after a short wait and never count it as the work's own failure.
 */
export class BoxLowMemoryError extends Error {
  constructor(
    message: string,
    readonly availableMb: number,
    readonly requiredMb: number,
  ) {
    super(message);
    this.name = "BoxLowMemoryError";
  }
}

/** A box memory gate refused the work (any box, any subclass). */
export function isBoxLowMemoryError(
  error: unknown,
): error is BoxLowMemoryError {
  return error instanceof BoxLowMemoryError;
}

/**
 * The text every connector-box refusal carries (sync-box.ts
 * ConnectorBoxLowMemoryError). infra-failure.ts and transient-failure.ts
 * match the same words.
 */
const REFUSAL_TEXT =
  /has (\d+) MB of memory free; a connector run needs (\d+) MB/;

/**
 * The box memory refusal behind `error`, or null.
 *
 * A refusal rarely reaches a caller as itself. Schema resolution wraps it
 * (SchemaResolutionError, as its `cause`), and other wrappers keep only its
 * message. On 19 Nov 2026 a wrapped refusal failed a 16-hour CDC backfill
 * because `instanceof` missed it. This walks the cause chain, then reads the
 * refusal's own words from the message.
 */
export function boxLowMemoryRefusal(error: unknown): BoxLowMemoryError | null {
  let current: unknown = error;
  for (let depth = 0; depth < 8 && current; depth++) {
    if (current instanceof BoxLowMemoryError) return current;
    current = (current as { cause?: unknown }).cause;
  }
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : "";
  const match = REFUSAL_TEXT.exec(message);
  return match
    ? new BoxLowMemoryError(message, Number(match[1]), Number(match[2]))
    : null;
}

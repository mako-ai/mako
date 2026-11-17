/**
 * Boxed shadow and switch for built-in connectors: the flag and the gate's
 * numbers (RFC connector-runtime §10, iteration 5).
 *
 * Read at call time, never at module load, as boxes/config.ts.
 */

/**
 * A flow on a built-in connection may run its folder twin in a box: as a
 * shadow into its own dataset, or switched (`runtime: boxed`). Off unless
 * this is exactly "true". Off, every flow runs its built-in connector, a
 * `runtime: boxed` setting is ignored, and shadow flows refuse to run.
 */
export function connectorBoxedSwitchEnabled(): boolean {
  return process.env.CONNECTOR_BOXED_SWITCH === "true";
}

/** The built-in connectors whose flows may run boxed. */
export const BOXED_CAPABLE_TYPES: ReadonlySet<string> = new Set([
  "close",
  "stripe",
  "pandadoc",
  "calendly",
  "claap",
  "wise",
  "posthog",
]);

/**
 * The switch gate (Joan, 2026-11-17): evidence, same day, any connector.
 * 1. A full key comparison of every entity with 0 unexplained gaps (a key
 *    changed after the cutoff is in flight, so explained).
 * 2. Column coverage: every live column exists in the shadow.
 * 3. 0 new NULL rows: no row where live has a value and the shadow NULL.
 * 4. Freshness and errors over the last 30 minutes after the backfill:
 *    live updates the shadow also has, its lag, and no failed shadow run,
 *    entity or webhook batch.
 * Other value differences are reported, with samples, and do not block.
 */
export const PARITY_GATE = {
  /** The freshness and error window, after the shadow's full backfill. */
  windowMinutes: 30,
  /** The latest clean check must be this recent to open the gate. */
  maxCheckAgeMinutes: 60,
  /** p95 of how much later the shadow wrote a live change than live did. */
  maxLagP95Seconds: 15 * 60,
  /**
   * A row changed less than this before the cutoff may still be in flight
   * on one side (a poll mid-run, a webhook batch queued).
   */
  cutoffMarginMinutes: 10,
  /** Differing fields reported per entity, with up to 3 samples each. */
  topFields: 10,
  samplesPerField: 3,
} as const;

/** How often the scheduled parity check runs for each active shadow. */
export const PARITY_CRON = "*/15 * * * *";

/** The Inngest event that runs one parity check (inngest/functions/connector-parity.ts). */
export const CONNECTOR_PARITY_CHECK_EVENT = "connector/parity.check";

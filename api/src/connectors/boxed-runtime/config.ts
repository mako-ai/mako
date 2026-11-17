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

export const PARITY_GATE = {
  /** Live updates the shadow must have kept up with before a switch. */
  windowMinutes: 120,
  /** The latest clean check must be this recent to open the gate. */
  maxCheckAgeMinutes: 90,
  /**
   * Share of compared keys allowed to differ (missing on a side, or with a
   * differing field checksum). 0: every compared row must match.
   */
  tolerance: 0,
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
export const PARITY_CRON = "20 * * * *";

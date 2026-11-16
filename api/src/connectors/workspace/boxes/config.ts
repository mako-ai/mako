/**
 * Connector box leases: the flag and the knobs (RFC connector-runtime §6).
 *
 * Read at call time, never at module load, so dotenv ordering and tests that
 * set the environment cannot freeze a value.
 */

/** Leases are off unless this is exactly "true". Off = one box per workspace. */
export function connectorBoxLeasesEnabled(): boolean {
  return process.env.CONNECTOR_BOX_LEASES === "true";
}

export interface BoxLeaseConfig {
  /** Idle running box is paused after this long without a lease. */
  idlePauseMs: number;
  /** Paused box TTL when its connection ran recently (see recentWindowMs). */
  ttlRecentMs: number;
  /** Paused box TTL otherwise. */
  ttlStaleMs: number;
  /** "Recently" for the TTL choice: the box's previous run was this close. */
  recentWindowMs: number;
  /** How often a running lease beats. */
  heartbeatMs: number;
  /** A lease with no beat for this long is dead and its box is killed. */
  heartbeatTimeoutMs: number;
  /** Added to the command timeout to make the lease deadline. */
  deadlineMarginMs: number;
  /** Retire a box after this many failed runs (K). */
  maxFailures: number;
  /** Retire a box after this age (M). */
  maxAgeMs: number;
  /** Boxes one connection may hold leased at once; more runs queue. */
  maxPerConnection: number;
  /** A run gives up waiting in the queue after this long. */
  queueWaitMs: number;
  /** Snapshot a prepared box per key and start new boxes from it. */
  snapshots: boolean;
  /** Templates unused this long are deleted. */
  templateTtlMs: number;
  /** Ping timeout before a lease. */
  pingTimeoutMs: number;
  /**
   * An idle box whose last run succeeded this recently is leased without a
   * ping: that run was the liveness check. New, resumed and longer-idle
   * boxes are still pinged. Keep it well under E2B's own idle timeout.
   */
  livenessTtlMs: number;
  /**
   * The provider account's limit on running boxes. E2B counts app sessions,
   * workspace sync boxes and connector boxes against one limit.
   */
  accountCeiling: number;
  /**
   * Slots connector boxes never take, kept for app sessions. A connector box
   * starts or resumes only while the account runs fewer than
   * accountCeiling - appReserve boxes, app sessions included.
   */
  appReserve: number;
  /** How long a count of the account's running boxes is reused. */
  accountCountTtlMs: number;
}

const SECOND = 1_000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

export const BOX_LEASE_DEFAULTS: Readonly<BoxLeaseConfig> = {
  idlePauseMs: 45 * SECOND,
  ttlRecentMs: DAY,
  ttlStaleMs: HOUR,
  recentWindowMs: DAY,
  heartbeatMs: 15 * SECOND,
  heartbeatTimeoutMs: 90 * SECOND,
  deadlineMarginMs: 5 * MINUTE,
  maxFailures: 3,
  maxAgeMs: 6 * HOUR,
  maxPerConnection: 4,
  queueWaitMs: 10 * MINUTE,
  snapshots: true,
  templateTtlMs: 7 * DAY,
  pingTimeoutMs: 10 * SECOND,
  livenessTtlMs: 30 * SECOND,
  accountCeiling: 20,
  appReserve: 2,
  accountCountTtlMs: 5 * SECOND,
};

/** The environment variable behind each knob. */
export const BOX_LEASE_ENV: Readonly<Record<keyof BoxLeaseConfig, string>> = {
  idlePauseMs: "CONNECTOR_BOX_IDLE_PAUSE_MS",
  ttlRecentMs: "CONNECTOR_BOX_TTL_RECENT_MS",
  ttlStaleMs: "CONNECTOR_BOX_TTL_STALE_MS",
  recentWindowMs: "CONNECTOR_BOX_RECENT_WINDOW_MS",
  heartbeatMs: "CONNECTOR_BOX_HEARTBEAT_MS",
  heartbeatTimeoutMs: "CONNECTOR_BOX_HEARTBEAT_TIMEOUT_MS",
  deadlineMarginMs: "CONNECTOR_BOX_DEADLINE_MARGIN_MS",
  maxFailures: "CONNECTOR_BOX_MAX_FAILURES",
  maxAgeMs: "CONNECTOR_BOX_MAX_AGE_MS",
  maxPerConnection: "CONNECTOR_BOX_MAX_PER_CONNECTION",
  queueWaitMs: "CONNECTOR_BOX_QUEUE_WAIT_MS",
  snapshots: "CONNECTOR_BOX_SNAPSHOTS",
  templateTtlMs: "CONNECTOR_BOX_TEMPLATE_TTL_MS",
  pingTimeoutMs: "CONNECTOR_BOX_PING_TIMEOUT_MS",
  livenessTtlMs: "CONNECTOR_BOX_LIVENESS_TTL_MS",
  accountCeiling: "CONNECTOR_BOX_ACCOUNT_CEILING",
  appReserve: "CONNECTOR_BOX_APP_RESERVE",
  accountCountTtlMs: "CONNECTOR_BOX_ACCOUNT_COUNT_TTL_MS",
};

function positiveInt(name: string, fallback: number, min = 1): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= min ? Math.floor(value) : fallback;
}

export function boxLeaseConfig(
  overrides: Partial<BoxLeaseConfig> = {},
): BoxLeaseConfig {
  const config = { ...BOX_LEASE_DEFAULTS };
  for (const key of Object.keys(BOX_LEASE_ENV) as (keyof BoxLeaseConfig)[]) {
    if (key === "snapshots") continue;
    (config[key] as number) = positiveInt(
      BOX_LEASE_ENV[key],
      BOX_LEASE_DEFAULTS[key] as number,
      key === "appReserve" ? 0 : 1,
    );
  }
  const snapshots = process.env[BOX_LEASE_ENV.snapshots];
  if (snapshots !== undefined && snapshots.trim() !== "") {
    config.snapshots = snapshots === "true";
  }
  return { ...config, ...overrides };
}

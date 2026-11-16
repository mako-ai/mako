/**
 * Read sessions: the flag and the knobs (session-read.ts).
 *
 * Read at call time, never at module load, as boxes/config.ts.
 */
import {
  MAX_CONNECTOR_PROTOCOL_BYTES,
  MAX_CONNECTOR_PROTOCOL_MESSAGES,
} from "./sync-box";
import type { SessionLimits } from "./session-isolation";

/**
 * One connector process per entity read, instead of one per chunk. Off
 * unless this is exactly "true"; off keeps the chunk-per-process path.
 */
export function connectorSessionReadsEnabled(): boolean {
  return process.env.CONNECTOR_SESSION_READS === "true";
}

export const SESSION_DEFAULTS = {
  /** Batches the connector may run ahead of the API. */
  buffer: 2,
  /**
   * No acknowledgement for this long ends a session: the API died. Below
   * E2B's 15-minute idle pause, so an abandoned session's credential is gone
   * before its box could be paused with it in memory.
   */
  idleMs: 5 * 60 * 1000,
  /** A session ends after this long; the next batch starts a fresh one. */
  maxAgeMs: 60 * 60 * 1000,
} as const;

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw.trim() === "") return fallback;
  const value = Number(raw);
  return Number.isFinite(value) && value >= 1 ? Math.floor(value) : fallback;
}

export function sessionLimits(): SessionLimits {
  return {
    maxBytes: MAX_CONNECTOR_PROTOCOL_BYTES,
    maxMessages: MAX_CONNECTOR_PROTOCOL_MESSAGES,
    buffer: positiveInt("CONNECTOR_SESSION_BUFFER", SESSION_DEFAULTS.buffer),
    idleMs: positiveInt("CONNECTOR_SESSION_IDLE_MS", SESSION_DEFAULTS.idleMs),
    maxAgeMs: positiveInt(
      "CONNECTOR_SESSION_MAX_MS",
      SESSION_DEFAULTS.maxAgeMs,
    ),
  };
}

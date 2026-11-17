/**
 * Webhook batches for workspace (boxed) connectors: the flag and the knobs
 * (webhook-batch.ts).
 *
 * Read at call time, never at module load, as boxes/config.ts.
 */
import { MAX_CONNECTOR_PROTOCOL_BYTES } from "./sync-box";

/**
 * A `ws:` connection's webhooks are verified in the API and handed to its
 * connector in batches inside a box. Off unless this is exactly "true"; off
 * keeps today's path, where a boxed connector declares no webhooks.
 */
export function connectorWebhookBatchesEnabled(): boolean {
  return process.env.CONNECTOR_WEBHOOK_BATCHES === "true";
}

const positive = (name: string, fallback: number, max: number): number => {
  const value = Number(process.env[name]);
  return Number.isSafeInteger(value) && value > 0
    ? Math.min(value, max)
    : fallback;
};

export const WEBHOOK_BATCH_DEFAULTS = {
  /** Events per batch. */
  maxEvents: 500,
  /** Bytes of the batch file (the events as JSON). A quarter of the cap. */
  maxBytes: 8 * 1024 * 1024,
  /** One batch's command in the box, end to end. */
  timeoutMs: 60_000,
  /** Batches one run takes before it hands over to the next cron. */
  maxBatchesPerRun: 8,
  /** Change records one event may yield. */
  maxRecordsPerEvent: 1_000,
} as const;

export interface WebhookBatchLimits {
  maxEvents: number;
  maxBytes: number;
  timeoutMs: number;
  maxBatchesPerRun: number;
  maxRecordsPerEvent: number;
}

/**
 * The limits, with environment overrides clamped: no setting lets a batch
 * file pass half the 32 MiB protocol cap, or a command run past 5 minutes.
 */
export function webhookBatchLimits(): WebhookBatchLimits {
  const d = WEBHOOK_BATCH_DEFAULTS;
  return {
    maxEvents: positive(
      "CONNECTOR_WEBHOOK_BATCH_MAX_EVENTS",
      d.maxEvents,
      5_000,
    ),
    maxBytes: positive(
      "CONNECTOR_WEBHOOK_BATCH_MAX_BYTES",
      d.maxBytes,
      Math.floor(MAX_CONNECTOR_PROTOCOL_BYTES / 2),
    ),
    timeoutMs: positive(
      "CONNECTOR_WEBHOOK_BATCH_TIMEOUT_MS",
      d.timeoutMs,
      5 * 60_000,
    ),
    maxBatchesPerRun: d.maxBatchesPerRun,
    maxRecordsPerEvent: d.maxRecordsPerEvent,
  };
}

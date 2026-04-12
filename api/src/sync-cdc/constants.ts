/**
 * Environment-configurable operational constants for the CDC pipeline.
 *
 * Each constant reads from an optional env var with a sensible default,
 * allowing per-deployment tuning without code changes.
 */

function envInt(key: string, fallback: number): number {
  const raw = process.env[key];
  if (raw === undefined) return fallback;
  const parsed = parseInt(raw, 10);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export const CDC_MATERIALIZE_BATCH_SIZE = envInt(
  "CDC_MATERIALIZE_BATCH_SIZE",
  2500,
);

export const CDC_HARD_DELETE_CHUNK_SIZE = envInt(
  "CDC_HARD_DELETE_CHUNK_SIZE",
  10_000,
);

export const CDC_WEBHOOK_DRAIN_LIMIT = envInt("CDC_WEBHOOK_DRAIN_LIMIT", 500);

export const CDC_WEBHOOK_DRAIN_CHUNK = envInt("CDC_WEBHOOK_DRAIN_CHUNK", 100);

export const CDC_WEBHOOK_MAX_RETRY_ATTEMPTS = envInt(
  "CDC_WEBHOOK_MAX_RETRY_ATTEMPTS",
  5,
);

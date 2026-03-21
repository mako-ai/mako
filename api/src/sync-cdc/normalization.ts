const VOLATILE_BACKFILL_IDEMPOTENCY_FIELDS = new Set([
  "_syncedAt",
  "_mako_source_ts",
  "_mako_ingest_seq",
  "_mako_ingest_ts",
  "_mako_source_kind",
  "_mako_run_id",
  "_mako_entity",
  "_mako_webhook_event_id",
]);

export function normalizePayloadKeys(
  payload?: Record<string, unknown>,
): Record<string, unknown> {
  const normalized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload || {})) {
    normalized[key.replace(/\./g, "_")] = value;
  }
  return normalized;
}

export function resolveSourceTimestamp(
  payload?: Record<string, unknown>,
  fallback?: Date,
): Date {
  const candidates = [
    payload?.date_updated,
    payload?.updated_at,
    payload?.date_created,
    payload?.created_at,
    payload?.timestamp,
    payload?._syncedAt,
  ];
  for (const value of candidates) {
    if (!value) continue;
    const parsed = value instanceof Date ? value : new Date(String(value));
    if (!Number.isNaN(parsed.getTime())) return parsed;
  }
  return fallback || new Date();
}

export function stableStringify(value: unknown): string {
  if (value === null || value === undefined) {
    return "null";
  }
  if (Array.isArray(value)) {
    return `[${value.map(item => stableStringify(item)).join(",")}]`;
  }
  if (value instanceof Date) {
    return JSON.stringify(value.toISOString());
  }
  if (typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([key, item]) => `${JSON.stringify(key)}:${stableStringify(item)}`);
    return `{${entries.join(",")}}`;
  }
  return JSON.stringify(value);
}

export function sanitizeBackfillPayloadForIdempotency(
  payload: Record<string, unknown>,
): Record<string, unknown> {
  const sanitized: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(payload)) {
    if (
      VOLATILE_BACKFILL_IDEMPOTENCY_FIELDS.has(key) ||
      key.startsWith("_mako_")
    ) {
      continue;
    }

    if (Array.isArray(value)) {
      sanitized[key] = value.map(item =>
        typeof item === "object" && item !== null
          ? sanitizeBackfillPayloadForIdempotency(
              item as Record<string, unknown>,
            )
          : item,
      );
      continue;
    }

    if (typeof value === "object" && value !== null) {
      sanitized[key] = sanitizeBackfillPayloadForIdempotency(
        value as Record<string, unknown>,
      );
      continue;
    }

    sanitized[key] = value;
  }
  return sanitized;
}

type ComparableChange = {
  recordId: string;
  sourceTs: Date | string;
  ingestSeq: number;
};

export function selectLatestChangePerRecord<T extends ComparableChange>(
  events: T[],
): T[] {
  const latestByRecord = new Map<string, T>();
  for (const event of events) {
    const current = latestByRecord.get(event.recordId);
    if (!current) {
      latestByRecord.set(event.recordId, event);
      continue;
    }
    const currentTs = new Date(current.sourceTs).getTime();
    const nextTs = new Date(event.sourceTs).getTime();
    if (nextTs > currentTs) {
      latestByRecord.set(event.recordId, event);
      continue;
    }
    if (nextTs === currentTs && event.ingestSeq > current.ingestSeq) {
      latestByRecord.set(event.recordId, event);
    }
  }
  return Array.from(latestByRecord.values());
}

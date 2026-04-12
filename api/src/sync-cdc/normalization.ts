import * as crypto from "crypto";
import type {
  ConnectorEntitySchema,
  ConnectorLogicalType,
} from "../connectors/base/BaseConnector";

const FLOW_TOKEN_LENGTH = 12;

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

function camelToSnake(str: string): string {
  return str.replace(/([a-z0-9])([A-Z])/g, "$1_$2").toLowerCase();
}

function baseEntityTableName(baseName: string, entity: string): string {
  const normalized = entity.includes(":")
    ? `${camelToSnake(entity.split(":")[1])}_${entity.split(":")[0]}`
    : entity;
  return baseName ? `${baseName}_${normalized}` : normalized;
}

function cdcFlowToken(flowId: string): string {
  const normalized = String(flowId || "")
    .trim()
    .toLowerCase();
  const alnum = normalized.replace(/[^a-z0-9]/g, "");

  if (alnum.length >= FLOW_TOKEN_LENGTH) {
    return `f${alnum.slice(-FLOW_TOKEN_LENGTH)}`;
  }

  const hash = crypto.createHash("sha1").update(normalized).digest("hex");
  return `f${(alnum + hash).slice(0, FLOW_TOKEN_LENGTH)}`;
}

export function cdcLiveTableName(
  basePrefix: string | undefined,
  entity: string,
): string {
  return baseEntityTableName(basePrefix || "", entity);
}

export function cdcStageTableName(
  basePrefix: string | undefined,
  entity: string,
  flowId: string,
): string {
  const liveTable = cdcLiveTableName(basePrefix, entity);
  return `${liveTable}__${cdcFlowToken(flowId)}__stage_changes`;
}

// ---------------------------------------------------------------------------
// Schema-driven payload normalization
// ---------------------------------------------------------------------------

export interface CoercionWarning {
  field: string;
  expectedType: ConnectorLogicalType;
  actualKind: string;
}

function coerceToTimestamp(value: unknown): Date | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value;
  }
  if (typeof value === "number" && Number.isFinite(value)) {
    const ms = value > 1e12 ? value : value * 1000;
    const parsed = new Date(ms);
    return Number.isNaN(parsed.getTime()) ? null : parsed;
  }
  const parsed = new Date(String(value));
  return Number.isNaN(parsed.getTime()) ? null : parsed;
}

function coerceToNumber(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") return Number.isFinite(value) ? value : null;
  const str = String(value).trim();
  if (str === "") return null;
  const parsed = Number(str);
  return Number.isFinite(parsed) ? parsed : null;
}

function coerceToInteger(value: unknown): number | null {
  if (value == null) return null;
  if (typeof value === "number") {
    return Number.isFinite(value) ? Math.trunc(value) : null;
  }
  const str = String(value).trim();
  if (str === "") return null;
  const parsed = Number(str);
  return Number.isFinite(parsed) ? Math.trunc(parsed) : null;
}

function coerceToBoolean(value: unknown): boolean | null {
  if (value == null) return null;
  if (typeof value === "boolean") return value;
  if (typeof value === "number") {
    if (value === 1) return true;
    if (value === 0) return false;
    return null;
  }
  const s = String(value).trim().toLowerCase();
  if (["true", "1", "yes", "y"].includes(s)) return true;
  if (["false", "0", "no", "n"].includes(s)) return false;
  return null;
}

function coerceToString(value: unknown): string | null {
  if (value == null) return null;
  if (value instanceof Date) {
    return Number.isNaN(value.getTime()) ? null : value.toISOString();
  }
  if (typeof value === "object") {
    try {
      return JSON.stringify(value);
    } catch {
      return String(value);
    }
  }
  return String(value);
}

function coerceValue(
  value: unknown,
  type: ConnectorLogicalType,
): { value: unknown; ok: boolean } {
  if (value == null) return { value: null, ok: true };
  switch (type) {
    case "timestamp": {
      const v = coerceToTimestamp(value);
      return { value: v, ok: v !== null };
    }
    case "number": {
      const v = coerceToNumber(value);
      return { value: v, ok: v !== null };
    }
    case "integer": {
      const v = coerceToInteger(value);
      return { value: v, ok: v !== null };
    }
    case "boolean": {
      const v = coerceToBoolean(value);
      return { value: v, ok: v !== null };
    }
    case "string": {
      const v = coerceToString(value);
      return { value: v, ok: v !== null };
    }
    case "json":
      return { value, ok: true };
    default:
      return { value, ok: true };
  }
}

export function normalizePayloadBySchema(
  payload: Record<string, unknown>,
  schema: ConnectorEntitySchema,
): { payload: Record<string, unknown>; warnings: CoercionWarning[] } {
  const result: Record<string, unknown> = {};
  const warnings: CoercionWarning[] = [];

  for (const [key, value] of Object.entries(payload)) {
    const fieldSchema = schema.fields[key];
    if (fieldSchema) {
      const coerced = coerceValue(value, fieldSchema.type);
      result[key] = coerced.value;
      if (!coerced.ok) {
        warnings.push({
          field: key,
          expectedType: fieldSchema.type,
          actualKind: typeof value,
        });
      }
    } else if (schema.unknownFieldPolicy === "string") {
      result[key] = coerceToString(value);
    }
  }

  for (const [key, fieldSchema] of Object.entries(schema.fields)) {
    if (key in result) continue;
    if (fieldSchema.derivedFrom && fieldSchema.derivedFrom in result) {
      result[key] = result[fieldSchema.derivedFrom];
    } else if (fieldSchema.defaultValue !== undefined) {
      result[key] = fieldSchema.defaultValue;
    }
  }

  return { payload: result, warnings };
}

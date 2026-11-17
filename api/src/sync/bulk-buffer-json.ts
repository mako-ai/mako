/**
 * Nested values enter the bulk backfill buffer as JSON text.
 *
 * The Parquet build writes a nested object or array to a VARCHAR column as
 * JSON.stringify(value). Buffered as a document, the same value is encoded
 * to BSON on insert and decoded back on flush, one object at a time: a Close
 * meeting with 1,800 attendees is 1,800 objects each way. Buffered as the
 * JSON text the build would write, it is one string each way.
 *
 * Only values whose text cannot differ are converted: plain objects and
 * arrays of strings, finite or non-finite numbers, booleans, nulls, Dates
 * and further plain values, in a column the build types VARCHAR. Anything
 * else (a Buffer, a BSON type, a bigint, an undefined member) stays as it
 * is, because its JSON before the BSON round trip differs from its JSON
 * after it.
 */
import type { ConnectorEntitySchema } from "../connectors/base/BaseConnector";
import { inferDuckDBType } from "../utils/streaming-parquet-builder";

function isJsonPlain(value: unknown): boolean {
  if (value === null) return true;
  switch (typeof value) {
    case "string":
    case "number":
    case "boolean":
      return true;
    case "object":
      break;
    default:
      return false;
  }
  if (value instanceof Date) return true;
  if (Array.isArray(value)) return value.every(isJsonPlain);
  const proto = Object.getPrototypeOf(value);
  if (proto !== Object.prototype && proto !== null) return false;
  return Object.values(value as Record<string, unknown>).every(isJsonPlain);
}

/** `record` with each nested value the build writes as JSON already JSON. */
export function nestedValuesAsJsonText(
  record: Record<string, unknown>,
  entitySchema?: ConnectorEntitySchema | null,
): Record<string, unknown> {
  let out: Record<string, unknown> | undefined;
  for (const [key, value] of Object.entries(record)) {
    if (value === null || typeof value !== "object" || value instanceof Date) {
      continue;
    }
    const type = entitySchema?.fields?.[key]?.type;
    if (inferDuckDBType(type) !== "VARCHAR") continue;
    if (!isJsonPlain(value)) continue;
    out ??= { ...record };
    out[key] = JSON.stringify(value);
  }
  return out ?? record;
}

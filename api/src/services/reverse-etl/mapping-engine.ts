import crypto from "crypto";
import type {
  MappingSpec,
  ReverseFlowSpec,
} from "../../schemas/reverse-flow.schema";
import type { OutboundEntitySchema } from "../../connectors/base/OutboundConnector";

export interface MapRowResult {
  payload: Record<string, unknown>;
  unmappedColumns: string[];
  errors: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function getPathValue(source: Record<string, unknown>, path: string): unknown {
  if (path in source) return source[path];
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  let cursor: unknown = source;
  for (const part of parts) {
    if (isRecord(cursor)) {
      cursor = cursor[part];
      continue;
    }
    if (Array.isArray(cursor)) {
      cursor = cursor[Number(part)];
      continue;
    }
    return undefined;
  }
  return cursor;
}

function setPathValue(
  target: Record<string, unknown>,
  path: string,
  value: unknown,
): void {
  const parts = path
    .replace(/\[(\d+)\]/g, ".$1")
    .split(".")
    .filter(Boolean);
  if (parts.length === 0) return;

  let cursor: Record<string, unknown> | unknown[] = target;
  for (let index = 0; index < parts.length; index++) {
    const part = parts[index];
    const isLast = index === parts.length - 1;
    const nextPart = parts[index + 1];
    const nextIsArray = nextPart !== undefined && /^\d+$/.test(nextPart);

    if (isLast) {
      if (Array.isArray(cursor)) {
        cursor[Number(part)] = value;
      } else {
        cursor[part] = value;
      }
      return;
    }

    if (Array.isArray(cursor)) {
      const arrayIndex = Number(part);
      if (!cursor[arrayIndex]) {
        cursor[arrayIndex] = nextIsArray ? [] : {};
      }
      cursor = cursor[arrayIndex] as Record<string, unknown> | unknown[];
      continue;
    }

    if (!cursor[part]) {
      cursor[part] = nextIsArray ? [] : {};
    }
    cursor = cursor[part] as Record<string, unknown> | unknown[];
  }
}

function renderTemplate(
  template: string,
  row: Record<string, unknown>,
): string {
  return template.replace(/\{\{\s*([^}]+?)\s*\}\}/g, (_match, rawPath) => {
    const value = getPathValue(row, String(rawPath).trim());
    return value === undefined || value === null ? "" : String(value);
  });
}

function toIsoDate(value: unknown): string | unknown {
  if (value === undefined || value === null || value === "") return value;
  const date = value instanceof Date ? value : new Date(String(value));
  if (Number.isNaN(date.getTime())) return value;
  return date.toISOString().split("T")[0];
}

function applyTransforms(
  value: unknown,
  mapping: MappingSpec,
  row: Record<string, unknown>,
): unknown {
  const transform = mapping.source.transform;
  if (!transform) return value;

  let next = transform.template
    ? renderTemplate(transform.template, row)
    : value;
  if (
    (next === undefined || next === null || next === "") &&
    transform.defaultValue !== undefined
  ) {
    next = transform.defaultValue;
  }

  if (transform.lookupMap && next !== undefined && next !== null) {
    const key = String(next);
    if (Object.prototype.hasOwnProperty.call(transform.lookupMap, key)) {
      next = transform.lookupMap[key];
    }
  }

  for (const op of transform.ops || []) {
    if (next === undefined || next === null) break;
    if (op === "trim") next = String(next).trim();
    if (op === "lowercase") next = String(next).toLowerCase();
    if (op === "uppercase") next = String(next).toUpperCase();
    if (op === "to_string") next = String(next);
    if (op === "to_number") {
      const parsed = Number(next);
      next = Number.isFinite(parsed) ? parsed : next;
    }
    if (op === "to_iso_date") next = toIsoDate(next);
  }

  return next;
}

export function mapRow(
  spec: Pick<ReverseFlowSpec, "mappings">,
  row: Record<string, unknown>,
): MapRowResult {
  const payload: Record<string, unknown> = {};
  const errors: string[] = [];
  const usedColumns = new Set<string>();

  for (const mapping of spec.mappings) {
    let value =
      mapping.source.const !== undefined
        ? mapping.source.const
        : mapping.source.column
          ? getPathValue(row, mapping.source.column)
          : undefined;

    if (mapping.source.column) {
      usedColumns.add(mapping.source.column);
    }

    value = applyTransforms(value, mapping, row);
    if (
      mapping.required &&
      (value === undefined || value === null || value === "")
    ) {
      errors.push(`Required mapping '${mapping.target}' resolved empty`);
      continue;
    }
    if (value === undefined) continue;
    setPathValue(payload, mapping.target, value);
  }

  return {
    payload,
    errors,
    unmappedColumns: Object.keys(row).filter(
      column => !usedColumns.has(column),
    ),
  };
}

export function assertSchema(
  spec: Pick<ReverseFlowSpec, "mappings">,
  resultColumns: string[],
  outboundSchema?: OutboundEntitySchema,
): void {
  const columns = new Set(resultColumns);
  const missing = spec.mappings
    .map(mapping => mapping.source.column)
    .filter((column): column is string => Boolean(column))
    .filter(column => !columns.has(column));

  if (missing.length > 0) {
    throw new Error(
      `Missing source columns: ${[...new Set(missing)].join(", ")}`,
    );
  }

  if (!outboundSchema) return;
  const invalidTargets = spec.mappings
    .map(mapping => mapping.target)
    .filter(target => !resolveOutboundField(outboundSchema, target));
  if (invalidTargets.length > 0) {
    throw new Error(
      `Unknown or non-writable destination fields: ${[
        ...new Set(invalidTargets),
      ].join(", ")}`,
    );
  }
}

function resolveOutboundField(
  outboundSchema: OutboundEntitySchema,
  target: string,
) {
  if (outboundSchema.fields[target]?.writable) {
    return outboundSchema.fields[target];
  }
  if (target.startsWith("custom.")) {
    return outboundSchema.fields[`custom_${target.slice("custom.".length)}`];
  }
  return undefined;
}

function stable(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stable);
  if (!isRecord(value)) return value;
  return Object.keys(value)
    .sort()
    .reduce<Record<string, unknown>>((acc, key) => {
      acc[key] = stable(value[key]);
      return acc;
    }, {});
}

export function contentHash(payload: Record<string, unknown>): string {
  return crypto
    .createHash("sha256")
    .update(JSON.stringify(stable(payload)))
    .digest("hex");
}

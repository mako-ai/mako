function normalizeBigInt(value: bigint): number | string {
  const max = BigInt(Number.MAX_SAFE_INTEGER);
  const min = BigInt(Number.MIN_SAFE_INTEGER);
  if (value <= max && value >= min) {
    return Number(value);
  }
  return value.toString();
}

export function toJsonSafe(
  value: unknown,
  seen = new WeakSet<object>(),
): unknown {
  if (typeof value === "bigint") {
    return normalizeBigInt(value);
  }

  if (
    value === null ||
    value === undefined ||
    typeof value === "string" ||
    typeof value === "number" ||
    typeof value === "boolean"
  ) {
    return value;
  }

  if (value instanceof Date) {
    return value.toISOString();
  }

  if (Array.isArray(value)) {
    return value.map(item => toJsonSafe(item, seen));
  }

  if (value instanceof Map) {
    return Object.fromEntries(
      Array.from(value.entries()).map(([key, item]) => [
        String(key),
        toJsonSafe(item, seen),
      ]),
    );
  }

  if (value instanceof Set) {
    return Array.from(value.values()).map(item => toJsonSafe(item, seen));
  }

  if (typeof value === "object") {
    if (seen.has(value)) {
      return "[Circular]";
    }

    seen.add(value);

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, item]) => [
        key,
        toJsonSafe(item, seen),
      ]),
    );
  }

  return String(value);
}

export function safeStringify(value: unknown, space?: number): string {
  return JSON.stringify(toJsonSafe(value), null, space);
}

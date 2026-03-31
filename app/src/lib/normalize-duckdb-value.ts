export function normalizeDuckDBValue(value: unknown): unknown {
  if (typeof value === "bigint") {
    const max = BigInt(Number.MAX_SAFE_INTEGER);
    const min = BigInt(Number.MIN_SAFE_INTEGER);
    if (value <= max && value >= min) {
      return Number(value);
    }
    return value.toString();
  }

  if (Array.isArray(value)) {
    return value.map(normalizeDuckDBValue);
  }

  if (value && typeof value === "object") {
    // Arrow Decimal128/typed-array values: coerce to number via toString()
    if (ArrayBuffer.isView(value)) {
      const num = Number(value.toString());
      return Number.isNaN(num) ? value.toString() : num;
    }

    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>).map(([key, nested]) => [
        key,
        normalizeDuckDBValue(nested),
      ]),
    );
  }

  return value;
}

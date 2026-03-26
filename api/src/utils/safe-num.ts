/**
 * Safely coerce an unknown value to a number, returning 0 for non-numeric values.
 * Used for extracting token counts from untyped LLM usage objects.
 */
export function toNum(val: unknown): number {
  if (typeof val === "number" && !isNaN(val)) return val;
  return 0;
}

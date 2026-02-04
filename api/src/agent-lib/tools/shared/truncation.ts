/**
 * Shared Truncation Utilities for Agent V2 Tools
 * Prevents context overflow by limiting string lengths, array sizes, object depths, etc.
 */

// Truncation constants
export const MAX_STRING_LENGTH = 200;
export const MAX_ARRAY_ITEMS = 10;
export const MAX_OBJECT_KEYS = 15;
export const MAX_NESTED_DEPTH = 3;
export const MAX_SAMPLE_ROWS = 25;
export const MAX_TOTAL_OUTPUT_SIZE = 50000;

/**
 * Infer BSON type from a value (for MongoDB documents)
 */
export const inferBsonType = (value: unknown): string => {
  if (value === null) return "null";
  if (Array.isArray(value)) return "array";
  if (
    typeof value === "object" &&
    value !== null &&
    "_bsontype" in value &&
    (value as { _bsontype: string })._bsontype === "ObjectId"
  ) {
    return "objectId";
  }
  if (value instanceof Date) return "date";
  if (
    typeof value === "object" &&
    value !== null &&
    "_bsontype" in value &&
    (value as { _bsontype: string })._bsontype === "Decimal128"
  ) {
    return "decimal";
  }
  if (typeof value === "object") return "object";
  return typeof value;
};

/**
 * Truncate a value recursively, handling nested objects and arrays
 */
export const truncateValue = (value: unknown, depth = 0): unknown => {
  if (depth > MAX_NESTED_DEPTH) return "[nested too deep]";
  if (value === null || value === undefined) return value;

  // Handle BSON types
  if (
    typeof value === "object" &&
    value !== null &&
    "_bsontype" in value &&
    (value as { _bsontype: string })._bsontype === "ObjectId"
  ) {
    return String(value);
  }
  if (
    typeof value === "object" &&
    value !== null &&
    "_bsontype" in value &&
    (value as { _bsontype: string })._bsontype === "Decimal128"
  ) {
    return String(value);
  }
  if (value instanceof Date) return value.toISOString();

  if (typeof value === "string") {
    if (value.length > MAX_STRING_LENGTH) {
      return (
        value.substring(0, MAX_STRING_LENGTH) +
        `... [truncated, ${value.length} chars total]`
      );
    }
    return value;
  }

  if (Array.isArray(value)) {
    const truncatedArray: unknown[] = value
      .slice(0, MAX_ARRAY_ITEMS)
      .map(item => truncateValue(item, depth + 1));
    if (value.length > MAX_ARRAY_ITEMS) {
      truncatedArray.push(`[... ${value.length - MAX_ARRAY_ITEMS} more items]`);
    }
    return truncatedArray;
  }

  if (typeof value === "object" && value !== null) {
    const keys = Object.keys(value);
    const truncatedObj: Record<string, unknown> = {};
    const keysToInclude = keys.slice(0, MAX_OBJECT_KEYS);

    for (const key of keysToInclude) {
      truncatedObj[key] = truncateValue(
        (value as Record<string, unknown>)[key],
        depth + 1,
      );
    }

    if (keys.length > MAX_OBJECT_KEYS) {
      truncatedObj["_truncated"] =
        `${keys.length - MAX_OBJECT_KEYS} more keys omitted`;
    }

    return truncatedObj;
  }

  return value;
};

/**
 * Truncate a single document/row
 */
export const truncateDocument = (doc: unknown): unknown =>
  truncateValue(doc, 0);

/**
 * Truncate query results (array of documents/rows)
 */
export const truncateQueryResults = (results: unknown): unknown => {
  if (!results) return results;

  if (Array.isArray(results)) {
    const maxResults = 100;
    const truncated = results
      .slice(0, maxResults)
      .map((doc: unknown) => truncateDocument(doc));
    if (results.length > maxResults) {
      return {
        data: truncated,
        _truncated: true,
        _message: `Showing ${maxResults} of ${results.length} results.`,
      };
    }
    return truncated;
  }

  if (typeof results === "object" && results !== null) {
    const resultsObj = results as Record<string, unknown>;
    if (resultsObj.data && Array.isArray(resultsObj.data)) {
      const truncatedData = truncateQueryResults(resultsObj.data);
      if (
        truncatedData &&
        typeof truncatedData === "object" &&
        !Array.isArray(truncatedData) &&
        (truncatedData as Record<string, unknown>).data
      ) {
        return { ...resultsObj, ...(truncatedData as Record<string, unknown>) };
      }
      return { ...resultsObj, data: truncatedData };
    }
    return truncateDocument(results);
  }

  return results;
};

/**
 * Truncate sample rows/documents for inspection output
 */
export const truncateSamples = (
  samples: unknown[],
  maxSamples: number = MAX_SAMPLE_ROWS,
): { samples: unknown[]; _note?: string } => {
  const truncatedSamples = samples
    .slice(0, maxSamples)
    .map((doc: unknown) => truncateDocument(doc));

  let output = {
    samples: truncatedSamples,
    _note:
      samples.length > maxSamples
        ? `Showing ${maxSamples} of ${samples.length} samples.`
        : undefined,
  };

  const outputSize = JSON.stringify(output).length;
  if (outputSize > MAX_TOTAL_OUTPUT_SIZE) {
    // Reduce sample count if output is too large
    const reducedCount = Math.max(5, Math.floor(maxSamples / 5));
    output = {
      samples: truncatedSamples.slice(0, reducedCount),
      _note: `Output was too large. Reduced to ${reducedCount} samples.`,
    };
  }

  return output;
};

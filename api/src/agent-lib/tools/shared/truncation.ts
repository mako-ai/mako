/**
 * Shared Truncation Utilities for Agent V2 Tools
 * Prevents context overflow by limiting string lengths, array sizes, object depths, etc.
 */

import type { AgentToolExecutionContext } from "../../../agents/types";
import { databaseConnectionService } from "../../../services/database-connection.service";

// Agent query timeout: how long server-side agent tools wait before aborting
export const AGENT_QUERY_TIMEOUT_MS = 60_000; // 60 seconds
export const AGENT_QUERY_TIMEOUT = "AGENT_QUERY_TIMEOUT";
export const AGENT_QUERY_ABORTED = "AGENT_QUERY_ABORTED";

export function createAgentExecutionId(prefix = "agent-query"): string {
  return `${prefix}-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

export function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) {
    throw new Error(AGENT_QUERY_ABORTED);
  }
}

export function isAgentToolAbortError(error: unknown): boolean {
  if (error instanceof Error && error.message === AGENT_QUERY_ABORTED) {
    return true;
  }
  if (error instanceof Error && error.name === "AbortError") return true;
  return false;
}

export function isAgentToolTimeoutError(error: unknown): boolean {
  return error instanceof Error && error.message === AGENT_QUERY_TIMEOUT;
}

export function registerAgentExecution(
  toolExecutionContext: AgentToolExecutionContext | undefined,
  prefix: string,
): {
  executionId: string;
  signal: AbortSignal | undefined;
  release: () => void;
} {
  const executionId =
    toolExecutionContext?.createExecutionId(prefix) ??
    createAgentExecutionId(prefix);
  toolExecutionContext?.registerExecution(executionId);
  return {
    executionId,
    signal: toolExecutionContext?.signal,
    release: () => toolExecutionContext?.releaseExecution(executionId),
  };
}

/**
 * Run a database operation with a timeout. On timeout, cancels the query
 * server-side (e.g. kills the BigQuery job) via the executionId.
 */
export async function withAgentTimeout<T>(
  executionId: string,
  fn: (execId: string) => Promise<T>,
  options?: {
    signal?: AbortSignal;
    onTimeout?: (executionId: string) => Promise<void> | void;
    onAbort?: (executionId: string) => Promise<void> | void;
    timeoutMs?: number;
  },
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  let removeAbortListener: (() => void) | undefined;

  const timeoutPromise = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(AGENT_QUERY_TIMEOUT)),
      options?.timeoutMs ?? AGENT_QUERY_TIMEOUT_MS,
    );
  });

  const abortSignal = options?.signal;
  const abortPromise = abortSignal
    ? new Promise<never>((_, reject) => {
        const handleAbort = () => reject(new Error(AGENT_QUERY_ABORTED));
        if (abortSignal.aborted) {
          handleAbort();
          return;
        }
        abortSignal.addEventListener("abort", handleAbort, { once: true });
        removeAbortListener = () =>
          abortSignal.removeEventListener("abort", handleAbort);
      })
    : null;

  try {
    throwIfAborted(options?.signal);
    const result = await Promise.race(
      [fn(executionId), timeoutPromise, abortPromise].filter(
        (candidate): candidate is Promise<T> | Promise<never> => !!candidate,
      ),
    );
    return result;
  } catch (err) {
    if (isAgentToolTimeoutError(err)) {
      const cancel =
        options?.onTimeout ??
        (async (id: string) => {
          await databaseConnectionService.cancelQuery(id);
        });
      await Promise.resolve(cancel(executionId)).catch(() => {});
    }
    if (isAgentToolAbortError(err)) {
      const cancel =
        options?.onAbort ??
        (async (id: string) => {
          await databaseConnectionService.cancelQuery(id);
        });
      await Promise.resolve(cancel(executionId)).catch(() => {});
    }
    throw err;
  } finally {
    clearTimeout(timer);
    removeAbortListener?.();
  }
}

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

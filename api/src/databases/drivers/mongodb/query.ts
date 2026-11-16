/**
 * Running one MongoDB query against a `Db`: a shell query (text, through
 * the interpreter) or a structured request (`{ collection, operation }`).
 */
import type { Db, Document } from "mongodb";
import { isWrite } from "../../../access/connection-writes";
import { loggers } from "../../../logging";
import {
  MongoShellError,
  runMongoShellQuery,
} from "../../../services/mongo-shell-interpreter";
import type { QueryResult } from "../../query-types";

const logger = loggers.db("mongodb");

/** A structured MongoDB request, as the API and tools send it. */
export interface MongoStructuredQuery {
  collection?: string;
  operation?: string;
  filter?: Document;
  options?: Document;
  pipeline?: Document[];
  documents?: Document[];
  update?: Document;
}

export function isCancellation(error: unknown): boolean {
  return (
    error instanceof Error &&
    (error.message.includes("cancelled") ||
      error.message.includes("aborted") ||
      error.name === "AbortError")
  );
}

/** `promise`, or a "Query cancelled" rejection once `signal` aborts. */
function raceWithAbort<T>(promise: Promise<T>, signal?: AbortSignal) {
  if (!signal) return promise;
  return Promise.race([
    promise,
    new Promise<never>((_, reject) => {
      if (signal.aborted) {
        reject(new Error("Query cancelled"));
      }
      signal.addEventListener(
        "abort",
        () => {
          reject(new Error("Query cancelled"));
        },
        { once: true },
      );
    }),
  ]);
}

export async function runStructuredMongoQuery(
  db: Db,
  query: MongoStructuredQuery,
  signal: AbortSignal | undefined,
  maxRows: number | undefined,
): Promise<QueryResult> {
  const collection = db.collection(query.collection as string);
  const race = <T>(promise: Promise<T>) => raceWithAbort(promise, signal);
  const options = query.options || {};
  let result: unknown;

  // A row cap reads one row past it, so the caller knows it cut.
  const capRead = maxRows !== undefined ? maxRows + 1 : undefined;
  switch (query.operation) {
    case "find": {
      const findOptions = { ...options };
      if (
        capRead !== undefined &&
        !(findOptions.limit > 0 && findOptions.limit <= capRead)
      ) {
        findOptions.limit = capRead;
      }
      result = await race(
        collection.find(query.filter || {}, findOptions).toArray(),
      );
      break;
    }
    case "findOne":
      result = await race(collection.findOne(query.filter || {}, options));
      break;
    case "aggregate": {
      const pipeline: Document[] = [...(query.pipeline || [])];
      const last = pipeline[pipeline.length - 1];
      if (
        capRead !== undefined &&
        !(last && ("$out" in last || "$merge" in last))
      ) {
        pipeline.push({ $limit: capRead });
      }
      result = await race(collection.aggregate(pipeline, options).toArray());
      break;
    }
    case "insertMany":
      result = await race(
        collection.insertMany(query.documents || [], options),
      );
      break;
    case "updateMany":
      result = await race(
        collection.updateMany(query.filter || {}, query.update || {}, options),
      );
      break;
    case "deleteMany":
      result = await race(collection.deleteMany(query.filter || {}, options));
      break;
    case "updateOne":
      result = await race(
        collection.updateOne(query.filter || {}, query.update || {}, options),
      );
      break;
    case "deleteOne":
      result = await race(collection.deleteOne(query.filter || {}, options));
      break;
    default:
      return {
        success: false,
        error: `Unsupported MongoDB operation: ${query.operation}`,
      };
  }

  return { success: true, data: result };
}

/**
 * A JSON replacer that survives what a shell query can return: BigInts,
 * driver objects (Collection, Db, cursors) and circular structures.
 */
function circularReplacer() {
  const seen = new WeakSet();
  return (_key: string, value: unknown) => {
    // Handle BigInt explicitly (convert to string)
    if (typeof value === "bigint") return value.toString();

    if (typeof value === "object" && value !== null) {
      // Replace common MongoDB driver objects with descriptive strings
      const ctor = value.constructor?.name;
      if (
        ctor === "Collection" ||
        ctor === "Db" ||
        ctor === "MongoClient" ||
        ctor === "Cursor" ||
        ctor === "AggregationCursor" ||
        ctor === "FindCursor"
      ) {
        // Provide minimal useful info instead of the full object
        if (ctor === "Collection") {
          return {
            _type: "Collection",
            name: (value as { collectionName?: string }).collectionName,
          };
        }
        return `[${ctor}]`;
      }

      // Handle circular structures
      if (seen.has(value)) {
        return "[Circular]";
      }
      seen.add(value);
    }
    return value;
  };
}

export async function runMongoShellText(
  db: Db,
  query: string,
  signal?: AbortSignal,
  maxRows?: number,
  /** A read-only run: no database command, read ones included. */
  readOnly?: boolean,
): Promise<{ data: unknown; truncated: boolean }> {
  logger.debug("Executing MongoDB query", { query: query.substring(0, 200) });

  // Check if already aborted
  if (signal?.aborted) {
    throw new Error("Query cancelled");
  }

  // Interpreted, never evaluated: the query is parsed and only `db` chains,
  // literals and the shell's value helpers run (mongo-shell-interpreter.ts).
  // A write method runs only if the query was classified as a write, and
  // so went through checkConnectionWrite in executeQuery.
  try {
    const { value: finalResult, truncated } = await runMongoShellQuery(
      db,
      query,
      {
        allowWrites: !readOnly && isWrite("mongodb", query),
        readOnly,
        signal,
        maxRows,
      },
    );

    logger.debug("Final result info", {
      type: typeof finalResult,
      isArray: Array.isArray(finalResult),
      length: Array.isArray(finalResult) ? finalResult.length : undefined,
      truncated,
    });

    // Ensure the result can be safely serialized to JSON (avoid circular refs)
    let serializedResult: unknown;
    try {
      serializedResult = JSON.parse(
        JSON.stringify(finalResult, circularReplacer()),
      );
    } catch (e) {
      logger.warn(
        "Failed to serialize result, falling back to string representation",
        { error: e },
      );
      serializedResult = String(finalResult);
    }

    return { data: serializedResult, truncated };
  } catch (error) {
    // A refused query (MongoShellError) is the user's to fix, and a
    // cancellation is expected: neither is a server error.
    if (error instanceof MongoShellError) {
      logger.info("Refused a MongoDB shell query", { error: error.message });
      throw error;
    }
    if (!isCancellation(error)) {
      logger.error("Error in executeMongoDBJavaScriptQuery", { error });
    }
    throw error;
  }
}

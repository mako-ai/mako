import { Db } from "mongodb";
import { mongoConnection } from "./mongodb-connection";
import mongoose from "mongoose";
import { loggers } from "../logging";

const logger = loggers.query();

export class QueryExecutor {
  async executeQuery(queryContent: string, databaseId?: string): Promise<any> {
    try {
      logger.debug("QueryExecutor.executeQuery called", {
        databaseId: databaseId || "none (will use default)",
      });

      // Get the appropriate database instance
      let dbInstance: Db;
      if (databaseId) {
        dbInstance = await mongoConnection.getDatabase(databaseId);
      } else {
        // Use the main database connection via mongoose
        const db = mongoose.connection.db;
        if (!db) {
          throw new Error("Main database connection not established");
        }
        dbInstance = db;
      }

      logger.debug("Executing query content", {
        databaseId,
        queryPreview: queryContent.substring(0, 200),
      });

      // Track async index operations to surface errors even if not awaited by the user
      const trackedIndexPromises: Promise<any>[] = [];
      const trackedIndexErrors: any[] = [];

      const wrapCollection = (collection: any) =>
        new Proxy(collection, {
          get: (target, prop, receiver) => {
            const original = Reflect.get(target, prop, receiver);
            if (typeof original === "function") {
              return (...args: any[]) => {
                try {
                  const result = original.apply(target, args);
                  if (result && typeof result.then === "function") {
                    result.catch((err: any) => {
                      trackedIndexErrors.push(err);
                    });
                    trackedIndexPromises.push(result);
                  }
                  if (result && typeof result === "object") {
                    return wrapCollection(result);
                  }
                  return result;
                } catch (err) {
                  trackedIndexErrors.push(err);
                  throw err;
                }
              };
            }
            if (original && typeof original === "object") {
              return wrapCollection(original);
            }
            return original;
          },
        });

      // Create a proxy db object that can access any collection dynamically
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const db = new Proxy(dbInstance, {
        get: (target, prop) => {
          // First check if this property exists on the target (database methods)
          if (prop in target) {
            const value = (target as any)[prop];
            if (prop === "collection" && typeof value === "function") {
              return (name: string, options?: any) => {
                const col = value.call(target, name, options);
                return wrapCollection(col);
              };
            }
            if (typeof value === "function") {
              return (...args: any[]) => {
                const fn = value.bind(target);
                const result = fn(...args);
                if (result && typeof result.then === "function") {
                  result.catch((err: any) => {
                    trackedIndexErrors.push(err);
                  });
                  trackedIndexPromises.push(result);
                }
                if (result && typeof result === "object") {
                  return wrapCollection(result);
                }
                return result;
              };
            }
            if (value && typeof value === "object") {
              return wrapCollection(value);
            }
            return value;
          }

          // Mongo-shell helper for db.getCollectionInfos([filter], [options])
          if (prop === "getCollectionInfos") {
            return (filter?: any, options?: any) => {
              return (target as Db).listCollections(filter, options).toArray();
            };
          }

          // Mongo-shell helper for db.getCollectionNames([filter])
          if (prop === "getCollectionNames") {
            return (filter?: any) => {
              return (target as Db)
                .listCollections(filter, { nameOnly: true })
                .toArray()
                .then(infos => infos.map(info => info.name));
            };
          }

          // Provide backwards-compatibility for Mongo-shell style helper db.getCollection(<name>)
          if (prop === "getCollection") {
            return (name: string) =>
              wrapCollection((target as Db).collection(name));
          }

          // If it's a string and not a database method, treat it as a collection name
          if (typeof prop === "string") {
            logger.debug("Accessing collection", { collection: prop });
            return wrapCollection(target.collection(prop));
          }

          return undefined;
        },
      });

      // Execute the query file content directly
      logger.debug("Evaluating query");
      const result = eval(queryContent);
      logger.debug("Raw result", {
        type: typeof result,
        constructor: result?.constructor?.name,
        hasToArray: typeof result?.toArray === "function",
        hasThen: typeof result?.then === "function",
      });

      // Handle MongoDB cursors and promises
      let finalResult;
      if (result && typeof result.then === "function") {
        // It's a promise, await it
        logger.debug("Awaiting promise");
        finalResult = await result;
        logger.debug("Promise resolved", { resultType: typeof finalResult });
      } else if (result && typeof result.toArray === "function") {
        // It's a MongoDB cursor, convert to array
        logger.debug("Converting cursor to array");
        finalResult = await result.toArray();
        logger.debug("Cursor converted", { arrayLength: finalResult?.length });
      } else {
        // It's a direct result
        logger.debug("Using direct result");
        finalResult = result;
      }

      logger.debug("Final result", {
        type: typeof finalResult,
        isArray: Array.isArray(finalResult),
        lengthOrValue: Array.isArray(finalResult) ? finalResult.length : finalResult,
      });

      // Ensure any index operations settle; surface the first error
      if (trackedIndexPromises.length > 0) {
        await Promise.allSettled(trackedIndexPromises);
        if (trackedIndexErrors.length > 0) {
          throw trackedIndexErrors[0];
        }
      }

      // 🌐 Ensure the result can be safely serialised to JSON (avoid circular refs)
      const getCircularReplacer = () => {
        const seen = new WeakSet();
        return (key: string, value: any) => {
          // Handle BigInt explicitly (convert to string)
          if (typeof value === "bigint") return value.toString();

          if (typeof value === "object" && value !== null) {
            // Replace common MongoDB driver objects with descriptive strings
            const ctor = value.constructor?.name;
            if (
              ctor === "Collection" ||
              ctor === "Db" ||
              ctor === "MongoClient" ||
              ctor === "Cursor"
            ) {
              // Provide minimal useful info instead of the full object
              if (ctor === "Collection") {
                return {
                  _type: "Collection",
                  name: (value as any).collectionName,
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
      };

      let serialisableResult: any;
      try {
        serialisableResult = JSON.parse(
          JSON.stringify(finalResult, getCircularReplacer()),
        );
      } catch {
        logger.warn("Failed to fully serialise result, falling back to string representation");
        serialisableResult = String(finalResult);
      }

      return serialisableResult;
    } catch (error) {
      logger.error("Query execution error", { error });
      throw new Error(
        `Query execution failed: ${
          error instanceof Error ? error.message : String(error)
        }`,
      );
    }
  }
}

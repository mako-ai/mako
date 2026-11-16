/**
 * The MongoDB engine: pooled clients (for data source connections and for
 * Mako's own database), queries, and session-based cancellation.
 */
import {
  MongoClient,
  type ClientSession,
  type Db,
  type MongoClientOptions,
} from "mongodb";
import type { IDatabaseConnection } from "../../../database/workspace-schema";
import { loggers } from "../../../logging";
import { ConnectionCache } from "../../connection-cache";
import type { QueryEngine } from "../../engine";
import {
  QUERY_NOT_FOUND,
  type CancelResult,
  type ConnectionTestResult,
  type DatabaseQuery,
  type QueryExecuteOptions,
  type QueryResult,
} from "../../query-types";
import {
  buildMongoDBConnectionString,
  extractDatabaseName,
} from "./connection-string";
import {
  isCancellation,
  runMongoShellText,
  runStructuredMongoQuery,
  type MongoStructuredQuery,
} from "./query";

const logger = loggers.db("mongodb");

// Types for different connection contexts
export type ConnectionContext =
  | "main" // Main application database
  | "destination" // Destination databases for sync
  | "datasource" // Data source databases
  | "workspace"; // Workspace-specific databases

export interface ConnectionConfig {
  connectionString: string;
  database: string;
}

export interface PooledMongoConnection {
  client: MongoClient;
  db: Db;
  context: ConnectionContext;
  identifier: string;
}

interface RunningMongoQuery {
  database: IDatabaseConnection;
  client: MongoClient;
  abortController: AbortController;
  session: ClientSession;
}

// Default MongoDB connection options - optimized for Cloud Run / serverless
const DEFAULT_MONGO_OPTIONS: MongoClientOptions = {
  maxPoolSize: 5,
  minPoolSize: 0, // No idle connections when unused
  maxIdleTimeMS: 10000, // Close idle connections after 10s
  serverSelectionTimeoutMS: 10000,
  socketTimeoutMS: 0,
  connectTimeoutMS: 10000,
  retryWrites: true,
  retryReads: true,
};

function connectionKey(context: ConnectionContext, identifier: string) {
  return `${context}:${identifier}`;
}

export class MongoEngine implements QueryEngine {
  readonly nonSql = true;

  // Keyed `${context}:${identifier}` (a data source: `datasource:<id>`).
  readonly connections = new ConnectionCache<PooledMongoConnection>({
    name: "MongoDB connection",
    close: ({ client }) => client.close(),
  });

  readonly runningQueries = new Map<string, RunningMongoQuery>();

  /**
   * The pooled client for `context:identifier`, connecting on first use.
   * No per-call ping: MongoClient monitors its topology and reconnects on
   * its own, and a client that does close removes itself from the pool.
   */
  async connect(
    context: ConnectionContext,
    identifier: string,
    config: ConnectionConfig,
    options?: MongoClientOptions,
  ): Promise<{ client: MongoClient; db: Db }> {
    const { client, db } = await this.connections.acquire(
      connectionKey(context, identifier),
      () => this.createConnection(context, identifier, config, options),
    );
    return { client, db };
  }

  async createConnection(
    context: ConnectionContext,
    identifier: string,
    config: ConnectionConfig,
    customOptions?: MongoClientOptions,
  ): Promise<PooledMongoConnection> {
    const key = connectionKey(context, identifier);
    logger.info("Creating pooled MongoDB connection", { key });

    const client = new MongoClient(config.connectionString, {
      ...DEFAULT_MONGO_OPTIONS,
      ...customOptions,
    });
    await client.connect();
    const db = client.db(config.database);

    // Each handler only drops the entry while it still holds THIS client:
    // an old, replaced client closing late must not evict (and so orphan)
    // the live one that took its key.
    const forget = () => this.forgetClient(key, client);
    client.on("close", () => {
      logger.info("MongoDB connection closed", { key });
      forget();
    });

    client.on("error", error => {
      logger.error("MongoDB connection error", { key, error });
      if (forget()) {
        client.close().catch(() => undefined);
      }
    });

    client.on("topologyClosed", () => {
      logger.info("MongoDB topology closed", { key });
      forget();
    });

    logger.info("MongoDB connected", { key });
    return { client, db, context, identifier };
  }

  /**
   * Drop the pool entry for `key` if (and only if) it holds `client`.
   * Returns whether it did.
   */
  forgetClient(key: string, client: MongoClient): boolean {
    const entry = this.connections.entry(key);
    if (entry?.value.client !== client) return false;
    return this.connections.forget(key, entry.value);
  }

  /** The pooled client of a data source connection. */
  async getConnection(database: IDatabaseConnection): Promise<MongoClient> {
    const { client } = await this.connect(
      "datasource",
      database._id.toString(),
      {
        connectionString: buildMongoDBConnectionString(database),
        database: database.connection.database || "",
      },
    );
    return client;
  }

  /** Connection for Mako's own database (DATABASE_URL). */
  async getMainConnection(): Promise<{ client: MongoClient; db: Db }> {
    const connectionString = process.env.DATABASE_URL;
    const databaseName =
      process.env.DATABASE_NAME ||
      extractDatabaseName(connectionString ?? "") ||
      "mako";

    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is not set");
    }

    const connection = await this.connect("main", "app", {
      connectionString,
      database: databaseName,
    });
    const key = connectionKey("main", "app");
    return {
      client: connection.client,
      db: this.trackUsage(connection.db, key),
    };
  }

  /** Connection by database ID (for destinations/datasources). */
  async getConnectionById(
    context: ConnectionContext,
    databaseId: string,
    lookupFn: (id: string) => Promise<ConnectionConfig | null>,
  ): Promise<{ client: MongoClient; db: Db }> {
    const key = connectionKey(context, databaseId);
    const existing = this.connections.entry(key);
    if (existing) {
      try {
        await existing.value.client.db("admin").command({ ping: 1 });
        this.connections.touch(key);
        return {
          client: existing.value.client,
          db: this.trackUsage(existing.value.db, key),
        };
      } catch {
        // Continue to recreate
      }
    }

    const config = await lookupFn(databaseId);
    if (!config) {
      throw new Error(`Database '${databaseId}' not found`);
    }

    const connection = await this.connect(context, databaseId, config);
    return {
      client: connection.client,
      db: this.trackUsage(connection.db, key),
    };
  }

  /** Update the last used time for a connection to keep it alive */
  touch(context: ConnectionContext, identifier: string): void {
    this.connections.touch(connectionKey(context, identifier));
  }

  /**
   * `db`, with every property access counted as a use of the pooled
   * connection, so a connection in use is never swept as idle.
   */
  private trackUsage(db: Db, key: string): Db {
    return new Proxy(db, {
      get: (target, prop, receiver) => {
        this.connections.touch(key);
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  getStats(): Array<{
    key: string;
    context: ConnectionContext;
    identifier: string;
    lastUsed: Date;
  }> {
    return this.connections.entryList().map(([key, entry]) => ({
      key,
      context: entry.value.context,
      identifier: entry.value.identifier,
      lastUsed: new Date(entry.lastUsed),
    }));
  }

  async closeConnection(databaseId: string): Promise<void> {
    await this.connections.close(connectionKey("datasource", databaseId));
  }

  async closeAllConnections(): Promise<void> {
    await this.connections.closeAll();
  }

  async sweepIdleConnections(maxIdleMs: number): Promise<void> {
    await this.connections.sweepIdle(maxIdleMs);
  }

  async testConnection(
    database: IDatabaseConnection,
  ): Promise<ConnectionTestResult> {
    // A throwaway client, closed after: a test is often of an unsaved
    // candidate (random _id), and pooling it would park a live client under
    // a key nothing ever uses again for the 15-minute idle window. It also
    // tests the configuration given, not a pooled client built from an
    // older one.
    let client: MongoClient | undefined;
    try {
      const connectionString = buildMongoDBConnectionString(database);
      client = new MongoClient(connectionString, {
        ...DEFAULT_MONGO_OPTIONS,
        maxPoolSize: 1,
      });
      await client.connect();
      await client.db("admin").command({ ping: 1 });
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "MongoDB connection failed",
      };
    } finally {
      await client?.close().catch(() => undefined);
    }
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: DatabaseQuery,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    const client = await this.getConnection(database);
    // Use database from options or fallback to connection default
    const dbName = options?.databaseName || database.connection.database;
    const db = client.db(dbName);

    const executionId = options?.executionId;
    let abortController: AbortController | undefined;
    let session: ClientSession | undefined;

    // Track this query for cancellation if executionId is provided
    if (executionId) {
      abortController = new AbortController();
      session = client.startSession();
      this.runningQueries.set(executionId, {
        database,
        client,
        abortController,
        session,
      });
    }
    // The caller's signal stops the await too, with or without an
    // executionId (and, with one, runs the same session kill as cancelQuery).
    const callerSignal = options?.signal;
    const onCallerAbort = () => {
      if (executionId && this.runningQueries.has(executionId)) {
        void this.cancelQuery(executionId);
      } else {
        abortController?.abort();
      }
    };
    if (callerSignal) {
      abortController ??= new AbortController();
      if (callerSignal.aborted) {
        abortController.abort();
      } else {
        callerSignal.addEventListener("abort", onCallerAbort, { once: true });
      }
    }

    try {
      if (abortController?.signal.aborted) {
        return { success: false, error: "Query cancelled" };
      }

      if (typeof query === "string") {
        const { data, truncated } = await runMongoShellText(
          db,
          query,
          abortController?.signal,
          options?.maxRows,
          options?.readOnly,
        );
        return truncated
          ? {
              success: true,
              data,
              truncated: true,
              rowCount: Array.isArray(data) ? data.length : undefined,
            }
          : { success: true, data };
      }
      const structured = query as MongoStructuredQuery;
      if (structured.collection && structured.operation) {
        return await runStructuredMongoQuery(
          db,
          structured,
          abortController?.signal,
          options?.maxRows,
        );
      }
      return { success: false, error: "Invalid MongoDB query format" };
    } catch (error) {
      if (isCancellation(error)) {
        return { success: false, error: "Query cancelled" };
      }
      return {
        success: false,
        error: error instanceof Error ? error.message : "MongoDB query failed",
      };
    } finally {
      callerSignal?.removeEventListener("abort", onCallerAbort);
      if (executionId) {
        this.runningQueries.delete(executionId);
      }
      if (session) {
        try {
          await session.endSession();
        } catch {
          // Ignore errors when ending session
        }
      }
    }
  }

  /**
   * Cancel a running MongoDB query using session-based cancellation.
   * This uses the session's lsid (logical session ID) to precisely kill
   * only operations belonging to this specific session.
   */
  async cancelQuery(executionId: string): Promise<CancelResult> {
    const running = this.runningQueries.get(executionId);
    if (!running) {
      return { success: false, error: QUERY_NOT_FOUND };
    }

    try {
      // First, abort the AbortController to stop the JavaScript promise
      running.abortController.abort();
      logger.debug("Aborted controller for MongoDB execution", { executionId });

      // killSessions targets only this session's operations, never another
      // user's queries.
      try {
        const sessionId = running.session.id;
        if (sessionId) {
          await running.client.db("admin").command({
            killSessions: [sessionId],
          });
          logger.debug("Killed MongoDB session for execution", { executionId });
        }
      } catch (killErr) {
        // killSessions might fail if user doesn't have sufficient privileges
        // This is okay - the AbortController should still work for the JS side
        logger.warn("Could not kill MongoDB session (may lack privileges)", {
          executionId,
          error: killErr,
        });
      }

      try {
        await running.session.endSession();
      } catch {
        // Ignore errors when ending session
      }

      this.runningQueries.delete(executionId);
      return { success: true };
    } catch (error) {
      logger.error("Error cancelling MongoDB query", { executionId, error });
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "Failed to cancel query",
      };
    }
  }
}

export const mongoEngine = new MongoEngine();

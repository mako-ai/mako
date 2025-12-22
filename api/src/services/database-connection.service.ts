import { MongoClient, Db, MongoClientOptions } from "mongodb";
import { Client as PgClient, Pool as PgPool } from "pg";
import * as mysql from "mysql2/promise";
import { ConnectionPool } from "mssql";
import { IDatabaseConnection } from "../database/workspace-schema";
import axios, { AxiosInstance } from "axios";
import crypto from "crypto";
import { DatabaseDriver } from "../databases/driver";
import { CloudSQLPostgresDatabaseDriver } from "../databases/drivers/cloudsql-postgres/driver";
import { CloudflareD1DatabaseDriver } from "../databases/drivers/cloudflare-d1/driver";
import { CloudflareKVDatabaseDriver } from "../databases/drivers/cloudflare-kv/driver";
import { Connector } from "@google-cloud/cloud-sql-connector";

export interface QueryResult {
  success: boolean;
  data?: any;
  error?: string;
  rowCount?: number;
  fields?: any[];
}

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

/**
 * Options for query execution
 * Used consistently across all database drivers
 */
export interface QueryExecuteOptions {
  /** Target database name (for cluster/server-level connections) */
  databaseName?: string;
  /** Sub-database ID (e.g., Cloudflare D1 database UUID) */
  databaseId?: string;
  /** Batch size for paginated queries (BigQuery) */
  batchSize?: number;
  /** Location/region for query execution (BigQuery) */
  location?: string;
}

interface PooledConnection {
  client: MongoClient;
  db: Db;
  lastUsed: Date;
  context: ConnectionContext;
  identifier: string;
}

/**
 * Enhanced Database Connection Service
 *
 * Provides unified connection management for all database types with:
 * - Advanced MongoDB connection pooling with health checks
 * - Multi-database support (PostgreSQL, MySQL, MSSQL, BigQuery, Cloudflare D1/KV)
 * - Automatic reconnection and idle cleanup
 * - Unified query execution interface
 */
export class DatabaseConnectionService {
  private connections: Map<string, any> = new Map();
  private cloudSqlPgConnectors: Map<string, Connector> = new Map();
  private cloudSqlPgPools: Map<string, PgPool> = new Map();
  private drivers: Map<string, DatabaseDriver> = new Map();

  // MongoDB-specific pooling
  private mongoConnections: Map<string, PooledConnection> = new Map();
  private cleanupInterval: NodeJS.Timeout | null = null;
  private readonly maxIdleTime = 15 * 60 * 1000; // 15 minutes to be safe

  // BigQuery auth/client caching (in-memory)
  private bigQueryClientCache: Map<
    string,
    { client: AxiosInstance; token: string; expiresAtMs: number }
  > = new Map();
  private bigQueryTokenInFlight: Map<
    string,
    Promise<{ token: string; expiresAtMs: number }>
  > = new Map();

  // Default MongoDB connection options
  private readonly defaultMongoOptions: MongoClientOptions = {
    maxPoolSize: 10,
    minPoolSize: 2,
    maxIdleTimeMS: 900000, // 15 minutes
    serverSelectionTimeoutMS: 10000,
    socketTimeoutMS: 0,
    connectTimeoutMS: 10000,
    retryWrites: true,
    retryReads: true,
  };

  constructor() {
    this.drivers.set(
      "cloudsql-postgres",
      new CloudSQLPostgresDatabaseDriver() as any,
    );
    this.drivers.set("cloudflare-d1", new CloudflareD1DatabaseDriver() as any);
    this.drivers.set("cloudflare-kv", new CloudflareKVDatabaseDriver() as any);
    // Start cleanup interval for MongoDB connections
    this.cleanupInterval = setInterval(() => {
      void this.cleanupIdleMongoConnections();
    }, 60000); // Every minute
  }

  /**
   * Test database connection
   */
  async testConnection(
    database: IDatabaseConnection,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      switch (database.type) {
        case "mongodb":
          return await this.testMongoDBConnection(database);
        case "postgresql":
          return await this.testPostgreSQLConnection(database);
        case "mysql":
          return await this.testMySQLConnection(database);
        case "mssql":
          return await this.testMSSQLConnection(database);
        case "bigquery":
          return await this.testBigQueryConnection(database);
        case "cloudsql-postgres":
          return await (
            this.drivers.get("cloudsql-postgres") as any
          ).testConnection(database);
        case "cloudflare-d1":
          return await (
            this.drivers.get("cloudflare-d1") as CloudflareD1DatabaseDriver
          ).testConnection(database);
        case "cloudflare-kv":
          return await (
            this.drivers.get("cloudflare-kv") as CloudflareKVDatabaseDriver
          ).testConnection(database);
        default:
          return {
            success: false,
            error: `Unsupported database type: ${database.type}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Execute query on database
   */
  async executeQuery(
    database: IDatabaseConnection,
    query: any,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    try {
      switch (database.type) {
        case "mongodb":
          return await this.executeMongoDBQuery(database, query, options);
        case "postgresql":
          return await this.executePostgreSQLQuery(database, query, options);
        case "cloudsql-postgres":
          return await this.drivers
            .get("cloudsql-postgres")!
            .executeQuery(database, query, options);
        case "mysql":
          return await this.executeMySQLQuery(database, query, options);
        case "mssql":
          return await this.executeMSSQLQuery(database, query);
        case "bigquery":
          return await this.executeBigQueryQuery(database, query, options);
        case "cloudflare-d1":
          return await this.drivers
            .get("cloudflare-d1")!
            .executeQuery(database, query, options);
        case "cloudflare-kv":
          return await this.drivers
            .get("cloudflare-kv")!
            .executeQuery(database, query, options);
        default:
          return {
            success: false,
            error: `Unsupported database type: ${database.type}`,
          };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "Unknown error",
      };
    }
  }

  /**
   * Get database connection
   */
  async getConnection(database: IDatabaseConnection): Promise<any> {
    const key = database._id.toString();

    // For MongoDB, use advanced pooling
    if (database.type === "mongodb") {
      const connection = await this.getMongoConnection(
        "datasource",
        database._id.toString(),
        {
          connectionString: this.buildMongoDBConnectionString(database),
          database: database.connection.database || "",
        },
      );
      return connection.client;
    }

    // For other database types, use basic caching
    if (this.connections.has(key)) {
      return this.connections.get(key);
    }

    let connection: any;

    switch (database.type) {
      case "postgresql":
        connection = await this.createPostgreSQLConnection(database);
        break;
      case "cloudsql-postgres":
        connection = await (
          this.drivers.get(
            "cloudsql-postgres",
          ) as CloudSQLPostgresDatabaseDriver
        ).getConnection(database);
        break;
      case "mysql":
        connection = await this.createMySQLConnection(database);
        break;
      case "mssql":
        connection = await this.createMSSQLConnection(database);
        break;
      case "bigquery":
        // BigQuery uses stateless HTTP requests; no persistent connection
        connection = null;
        break;
      default:
        throw new Error(`Unsupported database type: ${database.type}`);
    }

    this.connections.set(key, connection);
    return connection;
  }

  /**
   * Close database connection
   */
  async closeConnection(databaseId: string): Promise<void> {
    // Try to close MongoDB connection through pool
    await this.closeMongoConnection("datasource", databaseId);

    // Close CloudSQL through driver
    const cloudSqlDriver = this.drivers.get(
      "cloudsql-postgres",
    ) as CloudSQLPostgresDatabaseDriver;
    if (cloudSqlDriver) {
      await cloudSqlDriver.closeConnection(databaseId);
    }

    // Also handle any non-MongoDB connections in the local cache
    const connection = this.connections.get(databaseId);
    if (connection) {
      try {
        if (connection.end) {
          await connection.end();
        } else if (connection.close) {
          await connection.close();
        }
      } catch (error) {
        console.error("Error closing cached connection:", error);
      } finally {
        this.connections.delete(databaseId);
      }
    }

    const csConnector = this.cloudSqlPgConnectors.get(databaseId);
    if (csConnector) {
      try {
        await csConnector.close();
      } catch (error) {
        console.error("Error closing Cloud SQL connector:", error);
      } finally {
        this.cloudSqlPgConnectors.delete(databaseId);
      }
    }
  }

  /**
   * Close all connections
   */
  async closeAllConnections(): Promise<void> {
    // Close MongoDB connections
    if (this.cleanupInterval) {
      clearInterval(this.cleanupInterval);
      this.cleanupInterval = null;
    }

    const mongoPromises: Promise<void>[] = [];
    for (const [key, connection] of this.mongoConnections.entries()) {
      mongoPromises.push(
        connection.client
          .close()
          .then(() => console.log(`Closed MongoDB connection: ${key}`))
          .catch(error =>
            console.error(`Error closing MongoDB ${key}:`, error),
          ),
      );
    }
    await Promise.all(mongoPromises);
    this.mongoConnections.clear();

    // Close other connections
    const otherPromises = Array.from(this.connections.keys()).map(id =>
      this.closeConnection(id),
    );
    await Promise.all(otherPromises);

    // Close Cloud SQL pools first
    const cloudSqlDriver = this.drivers.get(
      "cloudsql-postgres",
    ) as CloudSQLPostgresDatabaseDriver;
    if (cloudSqlDriver) {
      await cloudSqlDriver.closeAllConnections();
    }
    const poolPromises = Array.from(this.cloudSqlPgPools.values()).map(pool =>
      pool
        .end()
        .catch(err => console.error("Error closing Cloud SQL pool:", err)),
    );
    await Promise.all(poolPromises);
    this.cloudSqlPgPools.clear();

    // Then close Cloud SQL connectors
    const csPromises = Array.from(this.cloudSqlPgConnectors.values()).map(c =>
      Promise.resolve(c.close()).catch((err: any) =>
        console.error("Error closing Cloud SQL connector:", err),
      ),
    );
    await Promise.all(csPromises);
    this.cloudSqlPgConnectors.clear();
  }

  /**
   * Get connection statistics
   */
  getStats(): {
    totalConnections: number;
    mongodb: number;
    other: number;
    mongoConnections: Array<{
      key: string;
      context: ConnectionContext;
      identifier: string;
      lastUsed: Date;
    }>;
  } {
    const mongoConnections = Array.from(this.mongoConnections.entries()).map(
      ([key, conn]) => ({
        key,
        context: conn.context,
        identifier: conn.identifier,
        lastUsed: conn.lastUsed,
      }),
    );

    return {
      totalConnections: this.mongoConnections.size + this.connections.size,
      mongodb: this.mongoConnections.size,
      other: this.connections.size,
      mongoConnections,
    };
  }

  // MongoDB Advanced Pooling Methods
  private async getMongoConnection(
    context: ConnectionContext,
    identifier: string,
    config: ConnectionConfig,
    options?: MongoClientOptions,
  ): Promise<{ client: MongoClient; db: Db }> {
    const key = this.getMongoConnectionKey(context, identifier);

    // Check existing connection
    const existing = this.mongoConnections.get(key);
    if (existing) {
      try {
        // Health check with timeout
        const pingPromise = existing.client.db("admin").command({ ping: 1 });
        const timeoutPromise = new Promise((_, reject) =>
          setTimeout(() => reject(new Error("Health check timeout")), 2000),
        );
        await Promise.race([pingPromise, timeoutPromise]);

        // Update last used time since we're actively using this connection
        existing.lastUsed = new Date();
        return { client: existing.client, db: existing.db };
      } catch (error) {
        console.warn(
          `MongoDB connection unhealthy for ${key}, reconnecting...`,
          error,
        );
        this.mongoConnections.delete(key);
        try {
          await existing.client.close();
        } catch {
          // Ignore close errors
        }
      }
    }

    // Create new connection
    return this.createMongoConnection(context, identifier, config, options);
  }

  // -------------------- BigQuery helpers --------------------
  // Public: list BigQuery datasets (by datasetId)
  async listBigQueryDatasets(database: IDatabaseConnection): Promise<string[]> {
    const { project_id, service_account_json, api_base_url } =
      (database.connection as any) || {};
    if (!project_id || !service_account_json) {
      throw new Error(
        "BigQuery requires 'project_id' and 'service_account_json' in connection",
      );
    }

    const client = await this.getBigQueryHttpClient(
      service_account_json,
      api_base_url,
    );

    const datasets: string[] = [];
    let pageToken: string | undefined;
    do {
      const params: any = { maxResults: 1000 };
      if (pageToken) params.pageToken = pageToken;
      const res = await client.get(`/projects/${project_id}/datasets`, {
        params,
      });
      const data = res.data || {};
      const items: any[] = Array.isArray(data.datasets) ? data.datasets : [];
      for (const ds of items) {
        const id = ds?.datasetReference?.datasetId;
        if (id) datasets.push(id);
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    return datasets.sort((a, b) => a.localeCompare(b));
  }

  // Public (autocomplete): list BigQuery datasets with prefix/limit and early-stop pagination
  async listBigQueryDatasetsForAutocomplete(
    database: IDatabaseConnection,
    opts?: { prefix?: string; limit?: number },
  ): Promise<string[]> {
    const { project_id, service_account_json, api_base_url } =
      (database.connection as any) || {};
    if (!project_id || !service_account_json) {
      throw new Error(
        "BigQuery requires 'project_id' and 'service_account_json' in connection",
      );
    }

    const prefix = String(opts?.prefix || "");
    const limit = Math.max(1, Math.min(200, Number(opts?.limit || 100)));

    const client = await this.getBigQueryHttpClient(
      service_account_json,
      api_base_url,
    );

    const datasets: string[] = [];
    let pageToken: string | undefined;
    do {
      const params: any = { maxResults: 1000 };
      if (pageToken) params.pageToken = pageToken;
      const res = await client.get(`/projects/${project_id}/datasets`, {
        params,
      });
      const data = res.data || {};
      const items: any[] = Array.isArray(data.datasets) ? data.datasets : [];
      for (const ds of items) {
        const id = ds?.datasetReference?.datasetId;
        if (!id) continue;
        if (prefix && !String(id).startsWith(prefix)) continue;
        datasets.push(String(id));
        if (datasets.length >= limit) {
          return datasets;
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    return datasets.sort((a, b) => a.localeCompare(b));
  }

  // Public: get columns for a single BigQuery table (for incremental autocomplete)
  async getBigQueryTableColumns(
    database: IDatabaseConnection,
    datasetId: string,
    tableId: string,
  ): Promise<Array<{ name: string; type: string }>> {
    const { project_id, service_account_json, api_base_url } =
      (database.connection as any) || {};
    if (!project_id || !service_account_json) {
      throw new Error(
        "BigQuery requires 'project_id' and 'service_account_json' in connection",
      );
    }
    if (!datasetId || !tableId) return [];

    const client = await this.getBigQueryHttpClient(
      service_account_json,
      api_base_url,
    );
    const res = await client.get(
      `/projects/${project_id}/datasets/${encodeURIComponent(
        datasetId,
      )}/tables/${encodeURIComponent(tableId)}`,
    );
    const fields: any[] = Array.isArray(res?.data?.schema?.fields)
      ? res.data.schema.fields
      : [];

    const out: Array<{ name: string; type: string }> = [];
    const flatten = (prefix: string, field: any) => {
      const name = String(field?.name || "");
      const type = String(field?.type || "");
      if (!name) return;
      const full = prefix ? `${prefix}.${name}` : name;
      out.push({ name: full, type });
      const nested: any[] = Array.isArray(field?.fields) ? field.fields : [];
      if (String(type).toUpperCase() === "RECORD" && nested.length > 0) {
        nested.forEach(f => flatten(full, f));
      }
    };
    fields.forEach(f => flatten("", f));
    return out;
  }

  // Public (autocomplete): list BigQuery tableIds for a dataset with prefix/limit and early-stop
  async listBigQueryTableIdsForAutocomplete(
    database: IDatabaseConnection,
    datasetId: string,
    opts?: { prefix?: string; limit?: number },
  ): Promise<string[]> {
    const { project_id, service_account_json, api_base_url } =
      (database.connection as any) || {};
    if (!project_id || !service_account_json) {
      throw new Error(
        "BigQuery requires 'project_id' and 'service_account_json' in connection",
      );
    }
    const prefix = String(opts?.prefix || "");
    const limit = Math.max(1, Math.min(200, Number(opts?.limit || 100)));

    const client = await this.getBigQueryHttpClient(
      service_account_json,
      api_base_url,
    );
    const out: string[] = [];
    let pageToken: string | undefined;
    do {
      const params: any = { maxResults: 1000 };
      if (pageToken) params.pageToken = pageToken;
      const res = await client.get(
        `/projects/${project_id}/datasets/${encodeURIComponent(
          datasetId,
        )}/tables`,
        { params },
      );
      const data = res.data || {};
      const tables: any[] = Array.isArray(data.tables) ? data.tables : [];
      for (const t of tables) {
        const tableId = t?.tableReference?.tableId;
        if (!tableId) continue;
        const tid = String(tableId);
        if (prefix && !tid.startsWith(prefix)) continue;
        out.push(tid);
        if (out.length >= limit) {
          return out;
        }
      }
      pageToken = data.nextPageToken;
    } while (pageToken);
    return out.sort((a, b) => a.localeCompare(b));
  }

  // Public: Get BigQuery schema (tables and columns) for autocomplete
  async getBigQuerySchema(
    database: IDatabaseConnection,
  ): Promise<
    Record<string, Record<string, Array<{ name: string; type: string }>>>
  > {
    const { project_id } = (database.connection as any) || {};
    if (!project_id) {
      throw new Error("BigQuery requires 'project_id' in connection");
    }

    // List all datasets first
    const datasetIds = await this.listBigQueryDatasets(database);

    const schema: Record<
      string,
      Record<string, Array<{ name: string; type: string }>>
    > = {};

    // Fetch schema for each dataset in parallel with concurrency limit
    const fetchDatasetSchema = async (datasetId: string) => {
      try {
        const query = `
          SELECT table_name, column_name, data_type 
          FROM \`${project_id}.${datasetId}.INFORMATION_SCHEMA.COLUMNS\`
          ORDER BY table_name, ordinal_position
        `;

        const result = await this.executeBigQueryQuery(database, query);
        if (result.success && Array.isArray(result.data)) {
          if (!schema[datasetId]) schema[datasetId] = {};

          for (const row of result.data) {
            const tableName = row.table_name;
            const colName = row.column_name;
            const colType = row.data_type;

            if (!schema[datasetId][tableName]) {
              schema[datasetId][tableName] = [];
            }
            schema[datasetId][tableName].push({ name: colName, type: colType });
          }
        }
      } catch (e) {
        console.warn(`Failed to fetch schema for dataset ${datasetId}`, e);
      }
    };

    const limit = 5;
    const runners: Promise<void>[] = [];
    let index = 0;
    const runNext = async () => {
      while (index < datasetIds.length) {
        const current = datasetIds[index++];
        await fetchDatasetSchema(current);
      }
    };
    for (let i = 0; i < Math.min(limit, datasetIds.length); i++) {
      runners.push(runNext());
    }
    await Promise.all(runners);

    return schema;
  }

  // Public: list BigQuery tables in a dataset
  async listBigQueryTables(
    database: IDatabaseConnection,
    datasetId: string,
  ): Promise<Array<{ name: string; type: string; options: any }>> {
    const { project_id, service_account_json, api_base_url } =
      (database.connection as any) || {};
    if (!project_id || !service_account_json) {
      throw new Error(
        "BigQuery requires 'project_id' and 'service_account_json' in connection",
      );
    }

    const client = await this.getBigQueryHttpClient(
      service_account_json,
      api_base_url,
    );

    const out: Array<{ name: string; type: string; options: any }> = [];
    let pageToken: string | undefined;
    do {
      const params: any = { maxResults: 1000 };
      if (pageToken) params.pageToken = pageToken;
      const res = await client.get(
        `/projects/${project_id}/datasets/${encodeURIComponent(
          datasetId,
        )}/tables`,
        { params },
      );
      const data = res.data || {};
      const tables: any[] = Array.isArray(data.tables) ? data.tables : [];
      for (const t of tables) {
        const tableId = t?.tableReference?.tableId;
        if (!tableId) continue;
        out.push({
          name: `${datasetId}.${tableId}`,
          type: t?.type || "TABLE",
          options: { datasetId, tableId },
        });
      }
      pageToken = data.nextPageToken;
    } while (pageToken);

    return out;
  }
  private async testBigQueryConnection(
    database: IDatabaseConnection,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const { project_id, service_account_json, location, api_base_url } =
        (database.connection as any) || {};
      if (!project_id || !service_account_json) {
        return {
          success: false,
          error:
            "BigQuery requires 'project_id' and 'service_account_json' in connection",
        };
      }

      const client = await this.getBigQueryHttpClient(
        service_account_json,
        api_base_url,
      );
      const body: any = {
        query: "SELECT 1 AS one",
        useLegacySql: false,
        maxResults: 1,
      };
      if (location) body.location = location;
      await client.post(`/projects/${project_id}/queries`, body);
      return { success: true };
    } catch (error: any) {
      return {
        success: false,
        error:
          (error?.response?.data?.error?.message as string) ||
          (error?.message as string) ||
          "BigQuery connection failed",
      };
    }
  }

  private async executeBigQueryQuery(
    database: IDatabaseConnection,
    query: string,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    try {
      if (typeof query !== "string" || !query.trim()) {
        return { success: false, error: "Query must be a non-empty string" };
      }
      const {
        project_id,
        service_account_json,
        location: dbLocation,
        api_base_url,
      } = (database.connection as any) || {};
      if (!project_id || !service_account_json) {
        return {
          success: false,
          error:
            "BigQuery requires 'project_id' and 'service_account_json' in connection",
        };
      }

      const client = await this.getBigQueryHttpClient(
        service_account_json,
        api_base_url,
      );
      const configuredLocation = options?.location || dbLocation;
      const batchSize = Math.max(
        1,
        Math.min(10000, options?.batchSize || 1000),
      );

      // Start the query
      const startBody: any = {
        query,
        useLegacySql: false,
        maxResults: batchSize,
      };
      if (configuredLocation) startBody.location = configuredLocation;
      let response = await client.post(
        `/projects/${project_id}/queries`,
        startBody,
      );

      let data = response.data || {};
      const jobId: string | undefined = data.jobReference?.jobId;
      // Extract location from job reference - this is critical for multi-region setups
      // BigQuery returns the actual location where the job was created
      const jobLocation: string | undefined =
        data.jobReference?.location || configuredLocation;
      let schema: any = data.schema;
      let pageToken: string | undefined = data.pageToken;
      const rowsAccum: any[] = [];

      // Wait for job completion if not immediately complete
      // BigQuery may return jobComplete: false for complex/long-running queries
      const maxWaitMs = 5 * 60 * 1000; // 5 minutes max wait
      const pollIntervalMs = 1000; // 1 second between polls
      let waitedMs = 0;

      while (data.jobComplete === false && jobId && waitedMs < maxWaitMs) {
        await new Promise(resolve => setTimeout(resolve, pollIntervalMs));
        waitedMs += pollIntervalMs;

        const params: any = { maxResults: batchSize };
        // Must use the job's actual location for polling
        if (jobLocation) params.location = jobLocation;
        response = await client.get(
          `/projects/${project_id}/queries/${jobId}`,
          { params },
        );
        data = response.data || {};
        schema = data.schema || schema;
      }

      if (data.jobComplete === false) {
        return {
          success: false,
          error: `Query timed out after ${maxWaitMs / 1000} seconds. The query may still be running in BigQuery.`,
        };
      }

      // Collect first page of results
      if (Array.isArray(data.rows) && schema) {
        rowsAccum.push(...this.bqMapRowsToObjects(data.rows, schema));
      }
      pageToken = data.pageToken;

      // Paginate through remaining results
      while (pageToken) {
        const params: any = { maxResults: batchSize };
        if (pageToken) params.pageToken = pageToken;
        // Must use the job's actual location for pagination
        if (jobLocation) params.location = jobLocation;
        response = await client.get(
          `/projects/${project_id}/queries/${jobId}`,
          { params },
        );
        data = response.data || {};
        schema = data.schema || schema;
        if (Array.isArray(data.rows) && schema) {
          rowsAccum.push(...this.bqMapRowsToObjects(data.rows, schema));
        }
        pageToken = data.pageToken;
      }

      return {
        success: true,
        data: rowsAccum,
        rowCount: rowsAccum.length,
      };
    } catch (error: any) {
      return {
        success: false,
        error:
          (error?.response?.data?.error?.message as string) ||
          (error?.message as string) ||
          "BigQuery query failed",
      };
    }
  }

  // New: list BigQuery datasets and tables via REST (fast, no deprecated auth)
  async listBigQueryDatasetsAndTables(
    database: IDatabaseConnection,
  ): Promise<Array<{ name: string; type: string; options: any }>> {
    const datasetIds = await this.listBigQueryDatasets(database);

    // Concurrency limiter
    const limit = 5;
    const results: Array<{ name: string; type: string; options: any }>[] = [];
    let index = 0;
    const runners: Promise<void>[] = [];
    const runNext = async () => {
      while (index < datasetIds.length) {
        const current = datasetIds[index++];
        const tables = await this.listBigQueryTables(database, current);
        results.push(tables);
      }
    };
    for (let i = 0; i < Math.min(limit, datasetIds.length); i++) {
      runners.push(runNext());
    }
    await Promise.all(runners);

    return results.flat();
  }

  private async getBigQueryHttpClient(
    serviceAccountJson: string | object,
    apiBaseUrl?: string,
  ): Promise<AxiosInstance> {
    const sa = this.parseServiceAccount(serviceAccountJson);
    const base = (apiBaseUrl || "https://bigquery.googleapis.com").trim();
    const normalized = /^https?:\/\//i.test(base) ? base : `https://${base}`;
    const baseURL = normalized.replace(/\/+$/, "") + "/bigquery/v2";

    const cacheKey = crypto
      .createHash("sha256")
      .update(`${sa.client_email}|${sa.token_uri}|${baseURL}`)
      .digest("hex");

    const cached = this.bigQueryClientCache.get(cacheKey);
    const now = Date.now();
    // Refresh token if expiring soon (within 2 minutes)
    const needsRefresh = !cached || cached.expiresAtMs - now < 2 * 60 * 1000;

    if (!needsRefresh && cached) {
      return cached.client;
    }

    const inFlight = this.bigQueryTokenInFlight.get(cacheKey);
    const tokenPromise =
      inFlight ||
      (async () => {
        try {
          return await this.createGoogleAccessTokenWithExpiry(sa);
        } finally {
          this.bigQueryTokenInFlight.delete(cacheKey);
        }
      })();

    if (!inFlight) {
      this.bigQueryTokenInFlight.set(cacheKey, tokenPromise);
    }

    const { token, expiresAtMs } = await tokenPromise;

    const client = cached?.client || axios.create({ baseURL });
    client.defaults.headers.common["Authorization"] = `Bearer ${token}`;
    client.defaults.headers.common["Content-Type"] = "application/json";
    this.bigQueryClientCache.set(cacheKey, { client, token, expiresAtMs });
    return client;
  }

  private parseServiceAccount(sa: string | object): {
    client_email: string;
    private_key: string;
    token_uri: string;
  } {
    let obj: any;
    try {
      obj = typeof sa === "string" ? JSON.parse(sa) : sa;
    } catch (e) {
      console.error("Failed to parse service_account_json:", e);
      throw new Error("Invalid service_account_json: Not a valid JSON string");
    }

    if (!obj || typeof obj !== "object") {
      throw new Error("Invalid service_account_json: Content is not an object");
    }

    return {
      client_email: obj.client_email,
      private_key: obj.private_key,
      token_uri: obj.token_uri || "https://oauth2.googleapis.com/token",
    };
  }

  private async createGoogleAccessTokenWithExpiry(sa: {
    client_email: string;
    private_key: string;
    token_uri: string;
  }): Promise<{ token: string; expiresAtMs: number }> {
    const now = Math.floor(Date.now() / 1000);
    const header = { alg: "RS256", typ: "JWT" };
    const payload = {
      iss: sa.client_email,
      scope: "https://www.googleapis.com/auth/bigquery.readonly",
      aud: sa.token_uri,
      iat: now,
      exp: now + 3600,
    } as any;
    const base64url = (input: Buffer | string) =>
      (Buffer.isBuffer(input) ? input : Buffer.from(input))
        .toString("base64")
        .replace(/=/g, "")
        .replace(/\+/g, "-")
        .replace(/\//g, "_");
    const encodedHeader = base64url(JSON.stringify(header));
    const encodedPayload = base64url(JSON.stringify(payload));
    const signingInput = `${encodedHeader}.${encodedPayload}`;
    const signer = crypto.createSign("RSA-SHA256");
    signer.update(signingInput);
    signer.end();
    const signature = signer.sign(sa.private_key);
    const assertion = `${signingInput}.${base64url(signature)}`;
    const res = await axios.post(
      sa.token_uri,
      new URLSearchParams({
        grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
        assertion,
      }),
      { headers: { "Content-Type": "application/x-www-form-urlencoded" } },
    );
    const token = res.data.access_token as string;
    const expiresInSec = Number(res.data.expires_in || 3600);
    // Refresh a bit early by setting the stored expiry slightly before real expiry
    const expiresAtMs = Date.now() + Math.max(60, expiresInSec - 60) * 1000;
    return { token, expiresAtMs };
  }

  private bqMapRowsToObjects(rows: any[], schema: any): any[] {
    const fields = (schema?.fields || []) as Array<any>;
    return (rows || []).map(r => this.bqMapRow(r, fields));
  }

  private bqMapRow(row: any, fields: Array<any>): any {
    const obj: Record<string, any> = {};
    const cells: any[] = Array.isArray(row?.f) ? row.f : [];
    for (let i = 0; i < fields.length; i++) {
      const field = fields[i];
      const cell = cells[i]?.v;
      obj[field.name] = this.bqParseCellValue(cell, field);
    }
    return obj;
  }

  private bqParseCellValue(value: any, field: any): any {
    if (value === null || value === undefined) return null;
    const mode = String(field?.mode || "").toUpperCase();
    const type = String(field?.type || "").toUpperCase();
    if (mode === "REPEATED") {
      const arr: any[] = Array.isArray(value) ? value : [];
      return arr.map(v =>
        this.bqParseCellValue(v?.v ?? v, { ...field, mode: undefined }),
      );
    }
    switch (type) {
      case "RECORD":
        return this.bqMapRow(value, field.fields || []);
      case "INTEGER":
      case "INT64":
      case "FLOAT":
      case "FLOAT64":
      case "NUMERIC":
      case "BIGNUMERIC":
        return value === "" ? null : Number(value);
      case "BOOLEAN":
      case "BOOL":
        return value === true || value === "true";
      default:
        return value;
    }
  }

  private async createMongoConnection(
    context: ConnectionContext,
    identifier: string,
    config: ConnectionConfig,
    customOptions?: MongoClientOptions,
  ): Promise<{ client: MongoClient; db: Db }> {
    const key = this.getMongoConnectionKey(context, identifier);
    console.log(`🔌 Creating pooled MongoDB connection: ${key}`);

    // Merge options
    const options = { ...this.defaultMongoOptions, ...customOptions };

    // Create client
    const client = new MongoClient(config.connectionString, options);
    await client.connect();

    // Handle database name extraction
    const databaseName = config.database;

    const db = client.db(databaseName);

    // Store in pool
    const pooledConnection: PooledConnection = {
      client,
      db,
      lastUsed: new Date(),
      context,
      identifier,
    };
    this.mongoConnections.set(key, pooledConnection);

    // Set up monitoring
    client.on("close", () => {
      console.log(`MongoDB connection closed: ${key}`);
      this.mongoConnections.delete(key);
    });

    client.on("error", error => {
      console.error(`MongoDB connection error for ${key}:`, error);
      this.mongoConnections.delete(key);
    });

    client.on("topologyClosed", () => {
      console.log(`MongoDB topology closed: ${key}`);
      this.mongoConnections.delete(key);
    });

    console.log(`✅ MongoDB connected: ${key}`);
    return { client, db };
  }

  private getMongoConnectionKey(
    context: ConnectionContext,
    identifier: string,
  ): string {
    return `${context}:${identifier}`;
  }

  private async cleanupIdleMongoConnections(): Promise<void> {
    const now = new Date();
    const toRemove: string[] = [];

    for (const [key, connection] of this.mongoConnections.entries()) {
      const idleTime = now.getTime() - connection.lastUsed.getTime();
      if (idleTime > this.maxIdleTime) {
        toRemove.push(key);
      }
    }

    for (const key of toRemove) {
      const connection = this.mongoConnections.get(key);
      if (connection) {
        try {
          await connection.client.close();
          console.log(`Closed idle MongoDB connection: ${key}`);
        } catch (error) {
          console.error(`Error closing idle MongoDB connection ${key}:`, error);
        }
        this.mongoConnections.delete(key);
      }
    }
  }

  private async closeMongoConnection(
    context: ConnectionContext,
    identifier: string,
  ): Promise<void> {
    const key = this.getMongoConnectionKey(context, identifier);
    const connection = this.mongoConnections.get(key);

    if (connection) {
      try {
        await connection.client.close();
        console.log(`Closed MongoDB connection: ${key}`);
      } catch (error) {
        console.error(`Error closing MongoDB connection ${key}:`, error);
      }
      this.mongoConnections.delete(key);
    }
  }

  // Utility methods
  private extractDatabaseName(connectionString: string): string | null {
    try {
      const url = new URL(connectionString);
      const pathname = url.pathname;
      if (pathname && pathname.length > 1) {
        return pathname.substring(1).split("?")[0];
      }
    } catch {
      // Invalid URL
    }
    return null;
  }

  // Convenience methods for MongoDB connections
  /**
   * Get connection for main application database
   */
  async getMainConnection(): Promise<{ client: MongoClient; db: Db }> {
    const connectionString = process.env.DATABASE_URL;
    const databaseName =
      process.env.DATABASE_NAME ||
      this.extractDatabaseName(connectionString!) ||
      "mako";

    if (!connectionString) {
      throw new Error("DATABASE_URL environment variable is not set");
    }

    const connection = await this.getMongoConnection("main", "app", {
      connectionString,
      database: databaseName,
    });

    // Wrap the database for automatic usage tracking
    const key = this.getMongoConnectionKey("main", "app");
    const wrappedDb = this.wrapDatabaseWithUsageTracking(connection.db, key);
    return { client: connection.client, db: wrappedDb };
  }

  /**
   * Get connection by database ID (for destinations/datasources)
   */
  async getConnectionById(
    context: ConnectionContext,
    databaseId: string,
    lookupFn: (id: string) => Promise<ConnectionConfig | null>,
  ): Promise<{ client: MongoClient; db: Db }> {
    // Try to get from pool first
    const key = this.getMongoConnectionKey(context, databaseId);
    const existing = this.mongoConnections.get(key);
    if (existing) {
      try {
        await existing.client.db("admin").command({ ping: 1 });
        existing.lastUsed = new Date();

        // Return wrapped database for automatic usage tracking
        const wrappedDb = this.wrapDatabaseWithUsageTracking(existing.db, key);
        return { client: existing.client, db: wrappedDb };
      } catch {
        // Continue to recreate
      }
    }

    // Lookup configuration
    const config = await lookupFn(databaseId);
    if (!config) {
      throw new Error(`Database '${databaseId}' not found`);
    }

    const connection = await this.getMongoConnection(
      context,
      databaseId,
      config,
    );

    // Wrap the database for automatic usage tracking
    const wrappedDb = this.wrapDatabaseWithUsageTracking(connection.db, key);
    return { client: connection.client, db: wrappedDb };
  }

  /**
   * Update the last used time for a connection to keep it alive
   */
  updateConnectionLastUsed(
    context: ConnectionContext,
    identifier: string,
  ): void {
    const key = this.getMongoConnectionKey(context, identifier);
    const connection = this.mongoConnections.get(key);
    if (connection) {
      connection.lastUsed = new Date();
    }
  }

  /**
   * Wrap a MongoDB database object with automatic usage tracking
   * Every time the database is used, it updates the connection's lastUsed timestamp
   */
  private wrapDatabaseWithUsageTracking(db: Db, connectionKey: string): Db {
    return new Proxy(db, {
      get: (target, prop, receiver) => {
        // Update lastUsed timestamp whenever any database operation is accessed
        const connection = this.mongoConnections.get(connectionKey);
        if (connection) {
          connection.lastUsed = new Date();
        }

        // Return the original property/method
        return Reflect.get(target, prop, receiver);
      },
    });
  }

  // MongoDB specific methods
  private async testMongoDBConnection(
    database: IDatabaseConnection,
  ): Promise<{ success: boolean; error?: string }> {
    try {
      const connectionString = this.buildMongoDBConnectionString(database);

      // Use unified pool for testing
      const connection = await this.getMongoConnection(
        "datasource",
        database._id.toString(),
        {
          connectionString,
          database: database.connection.database || "",
        },
      );

      // Test the connection
      await connection.db.admin().ping();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "MongoDB connection failed",
      };
    }
  }

  private buildMongoDBConnectionString(database: IDatabaseConnection): string {
    const conn = database.connection;

    // If connection string is provided, use it directly
    if (conn.connectionString) {
      return conn.connectionString;
    }

    // Build connection string from individual parameters
    let connectionString = "mongodb://";

    if (conn.username && conn.password) {
      connectionString += `${encodeURIComponent(conn.username)}:${encodeURIComponent(conn.password)}@`;
    }

    connectionString += `${conn.host || "localhost"}:${conn.port || 27017}`;

    if (conn.database) {
      connectionString += `/${conn.database}`;
    }

    const params: string[] = [];

    if (conn.authSource) {
      params.push(`authSource=${conn.authSource}`);
    }

    if (conn.replicaSet) {
      params.push(`replicaSet=${conn.replicaSet}`);
    }

    if (conn.ssl) {
      params.push("ssl=true");
    }

    if (params.length > 0) {
      connectionString += `?${params.join("&")}`;
    }

    return connectionString;
  }

  private async executeMongoDBQuery(
    database: IDatabaseConnection,
    query: any,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    const client = (await this.getConnection(database)) as MongoClient;
    // Use database from options or fallback to connection default
    const dbName = options?.databaseName || database.connection.database;
    const db = client.db(dbName);

    try {
      // Handle different MongoDB operations
      if (typeof query === "string") {
        // Parse JavaScript-style query
        const result = await this.executeMongoDBJavaScriptQuery(db, query);
        return { success: true, data: result };
      } else if (query.collection && query.operation) {
        // Handle structured query
        const collection = db.collection(query.collection);
        let result: any;

        switch (query.operation) {
          case "find":
            result = await collection
              .find(query.filter || {}, query.options || {})
              .toArray();
            break;
          case "findOne":
            result = await collection.findOne(
              query.filter || {},
              query.options || {},
            );
            break;
          case "aggregate":
            result = await collection
              .aggregate(query.pipeline || [], query.options || {})
              .toArray();
            break;
          case "insertMany":
            result = await collection.insertMany(
              query.documents || [],
              query.options || {},
            );
            break;
          case "updateMany":
            result = await collection.updateMany(
              query.filter || {},
              query.update || {},
              query.options || {},
            );
            break;
          case "deleteMany":
            result = await collection.deleteMany(
              query.filter || {},
              query.options || {},
            );
            break;
          case "updateOne":
            result = await collection.updateOne(
              query.filter || {},
              query.update || {},
              query.options || {},
            );
            break;
          case "deleteOne":
            result = await collection.deleteOne(
              query.filter || {},
              query.options || {},
            );
            break;
          default:
            return {
              success: false,
              error: `Unsupported MongoDB operation: ${query.operation}`,
            };
        }

        return { success: true, data: result };
      } else {
        return { success: false, error: "Invalid MongoDB query format" };
      }
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "MongoDB query failed",
      };
    }
  }

  private async executeMongoDBJavaScriptQuery(
    db: Db,
    query: string,
  ): Promise<any> {
    console.log("🔍 Executing query:", query.substring(0, 200) + "...");

    // Track async index operations to surface errors even if not awaited by the user
    const trackedIndexPromises: Promise<any>[] = [];
    const trackedIndexErrors: any[] = [];

    // Wrap a collection (and returned objects) to intercept ANY async calls and attach handlers
    const wrapCollection = (collection: any) =>
      new Proxy(collection, {
        get: (target, prop, receiver) => {
          const original = Reflect.get(target, prop, receiver);
          if (typeof original === "function") {
            return (...args: any[]) => {
              try {
                const result = original.apply(target, args);
                if (result && typeof result.then === "function") {
                  // Attach a handler so rejections are observed and recorded
                  result.catch((err: any) => {
                    trackedIndexErrors.push(err);
                  });
                  trackedIndexPromises.push(result);
                }
                // If the result is another driver object, wrap it too
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
    const dbProxy = new Proxy(db, {
      get: (target, prop) => {
        // First check if this property exists on the target (database methods)
        if (prop in target) {
          const value = (target as any)[prop];
          // If it's the collection() factory, wrap returned collection
          if (prop === "collection" && typeof value === "function") {
            return (name: string, options?: any) => {
              const col = value.call(target, name, options);
              return wrapCollection(col);
            };
          }
          if (typeof value === "function") {
            // Wrap db-level async methods to observe errors
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

        // Provide backwards-compatibility for Mongo-shell style helper db.getCollection(<n>)
        if (prop === "getCollection") {
          return (name: string) =>
            wrapCollection((target as Db).collection(name));
        }

        // If it's a string and not a database method, treat it as a collection name
        if (typeof prop === "string") {
          console.log(`📋 Accessing collection: ${prop}`);
          return wrapCollection(target.collection(prop));
        }

        return undefined;
      },
    });

    try {
      // Execute the query content directly - much simpler and more reliable
      console.log("⚡ Evaluating query...");
      // eslint-disable-next-line @typescript-eslint/no-unused-vars
      const db = dbProxy; // Make db available in eval context for evaluated queries
      const result = eval(query);

      console.log(`📤 Raw result type: ${typeof result}`);
      console.log(`📤 Raw result constructor: ${result?.constructor?.name}`);
      console.log(
        `📤 Has toArray method: ${typeof result?.toArray === "function"}`,
      );
      console.log(`📤 Has then method: ${typeof result?.then === "function"}`);

      // Handle MongoDB cursors and promises
      let finalResult;
      if (result && typeof result.then === "function") {
        // It's a promise, await it
        console.log("⏳ Awaiting promise...");
        finalResult = await result;
        console.log(`✅ Promise resolved, result type: ${typeof finalResult}`);
        console.log(
          `✅ Promise resolved constructor: ${finalResult?.constructor?.name}`,
        );
      } else if (result && typeof result.toArray === "function") {
        // It's a MongoDB cursor, convert to array
        console.log("📋 Converting cursor to array...");
        finalResult = await result.toArray();
        console.log(
          `✅ Cursor converted, array length: ${finalResult?.length}`,
        );
      } else {
        // It's a direct result
        console.log("📋 Using direct result");
        finalResult = result;
      }

      console.log(`🎯 Final result type: ${typeof finalResult}`);
      console.log(`🎯 Final result is array: ${Array.isArray(finalResult)}`);
      console.log(
        "🎯 Final result length/value:",
        Array.isArray(finalResult) ? finalResult.length : finalResult,
      );

      // Wait for any tracked index operations to settle, then surface errors
      if (trackedIndexPromises.length > 0) {
        await Promise.allSettled(trackedIndexPromises);
        if (trackedIndexErrors.length > 0) {
          // Throw the first tracked error so it is returned to the client
          throw trackedIndexErrors[0];
        }
      }

      // Ensure the result can be safely serialized to JSON (avoid circular refs)
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
              ctor === "Cursor" ||
              ctor === "AggregationCursor" ||
              ctor === "FindCursor"
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

      let serializedResult: any;
      try {
        serializedResult = JSON.parse(
          JSON.stringify(finalResult, getCircularReplacer()),
        );
      } catch (e) {
        console.error(
          "⚠️ Failed to fully serialize result, falling back to string representation",
          e,
        );
        serializedResult = String(finalResult);
      }

      return serializedResult;
    } catch (error) {
      console.error("❌ Error in executeMongoDBJavaScriptQuery:", error);
      throw error;
    }
  }

  // PostgreSQL specific methods
  private async testPostgreSQLConnection(
    database: IDatabaseConnection,
  ): Promise<{ success: boolean; error?: string }> {
    let client: PgClient | null = null;
    try {
      client = new PgClient({
        host: database.connection.host,
        port: database.connection.port || 5432,
        database: database.connection.database,
        user: database.connection.username,
        password: database.connection.password,
        ssl: database.connection.ssl ? { rejectUnauthorized: false } : false,
      });
      await client.connect();
      await client.query("SELECT 1");
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "PostgreSQL connection failed",
      };
    } finally {
      if (client) {
        await client.end();
      }
    }
  }

  private async createPostgreSQLConnection(
    database: IDatabaseConnection,
  ): Promise<PgClient> {
    const client = new PgClient({
      host: database.connection.host,
      port: database.connection.port || 5432,
      database: database.connection.database,
      user: database.connection.username,
      password: database.connection.password,
      ssl: database.connection.ssl ? { rejectUnauthorized: false } : false,
    });
    await client.connect();
    return client;
  }

  private async executePostgreSQLQuery(
    database: IDatabaseConnection,
    query: string,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    // Determine the target database: options override or connection default
    const targetDatabase =
      options?.databaseName || database.connection.database;

    // Check if we need a different database than what's cached in the connection
    const connectionDatabase = database.connection.database;
    let client: PgClient;

    if (targetDatabase && targetDatabase !== connectionDatabase) {
      // Need to create a new connection for the target database
      client = new PgClient({
        host: database.connection.host,
        port: database.connection.port || 5432,
        database: targetDatabase,
        user: database.connection.username,
        password: database.connection.password,
        ssl: database.connection.ssl ? { rejectUnauthorized: false } : false,
      });
      await client.connect();

      try {
        const result = await client.query(query);
        return {
          success: true,
          data: result.rows,
          rowCount: result.rowCount ?? undefined,
          fields: result.fields,
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error ? error.message : "PostgreSQL query failed",
        };
      } finally {
        // Close the temporary connection
        await client.end();
      }
    } else {
      // Use the cached connection
      client = (await this.getConnection(database)) as PgClient;
      try {
        const result = await client.query(query);
        return {
          success: true,
          data: result.rows,
          rowCount: result.rowCount ?? undefined,
          fields: result.fields,
        };
      } catch (error) {
        return {
          success: false,
          error:
            error instanceof Error ? error.message : "PostgreSQL query failed",
        };
      }
    }
  }

  // MySQL specific methods
  private async testMySQLConnection(
    database: IDatabaseConnection,
  ): Promise<{ success: boolean; error?: string }> {
    let connection: mysql.Connection | null = null;
    try {
      connection = await mysql.createConnection({
        host: database.connection.host,
        port: database.connection.port || 3306,
        database: database.connection.database,
        user: database.connection.username,
        password: database.connection.password,
        ssl: database.connection.ssl
          ? { rejectUnauthorized: false }
          : undefined,
      });
      await connection.ping();
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "MySQL connection failed",
      };
    } finally {
      if (connection) {
        await connection.end();
      }
    }
  }

  private async createMySQLConnection(
    database: IDatabaseConnection,
  ): Promise<mysql.Connection> {
    const connection = await mysql.createConnection({
      host: database.connection.host,
      port: database.connection.port || 3306,
      database: database.connection.database,
      user: database.connection.username,
      password: database.connection.password,
      ssl: database.connection.ssl ? { rejectUnauthorized: false } : undefined,
    });
    return connection;
  }

  private async executeMySQLQuery(
    database: IDatabaseConnection,
    query: string,
    options?: QueryExecuteOptions,
  ): Promise<QueryResult> {
    // Determine the target database: options override or connection default
    const targetDatabase =
      options?.databaseName || database.connection.database;

    const connectionDatabase = database.connection.database;
    let connection: mysql.Connection;

    if (targetDatabase && targetDatabase !== connectionDatabase) {
      // Need to create a new connection for the target database
      connection = await mysql.createConnection({
        host: database.connection.host,
        port: database.connection.port || 3306,
        database: targetDatabase,
        user: database.connection.username,
        password: database.connection.password,
        ssl: database.connection.ssl
          ? { rejectUnauthorized: false }
          : undefined,
      });

      try {
        const [rows, fields] = await connection.execute(query);
        return {
          success: true,
          data: rows,
          fields: fields,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "MySQL query failed",
        };
      } finally {
        await connection.end();
      }
    } else {
      // Use the cached connection
      connection = (await this.getConnection(database)) as mysql.Connection;
      try {
        const [rows, fields] = await connection.execute(query);
        return {
          success: true,
          data: rows,
          fields: fields,
        };
      } catch (error) {
        return {
          success: false,
          error: error instanceof Error ? error.message : "MySQL query failed",
        };
      }
    }
  }

  // MSSQL specific methods
  private async testMSSQLConnection(
    database: IDatabaseConnection,
  ): Promise<{ success: boolean; error?: string }> {
    let pool: ConnectionPool | null = null;
    try {
      pool = new ConnectionPool({
        server: database.connection.host!,
        port: database.connection.port || 1433,
        database: database.connection.database!,
        user: database.connection.username!,
        password: database.connection.password!,
        options: {
          encrypt: database.connection.ssl || false,
          trustServerCertificate: true,
        },
      });
      await pool.connect();
      await pool.request().query("SELECT 1");
      return { success: true };
    } catch (error) {
      return {
        success: false,
        error:
          error instanceof Error ? error.message : "MSSQL connection failed",
      };
    } finally {
      if (pool) {
        await pool.close();
      }
    }
  }

  private async createMSSQLConnection(
    database: IDatabaseConnection,
  ): Promise<ConnectionPool> {
    const pool = new ConnectionPool({
      server: database.connection.host!,
      port: database.connection.port || 1433,
      database: database.connection.database!,
      user: database.connection.username!,
      password: database.connection.password!,
      options: {
        encrypt: database.connection.ssl || false,
        trustServerCertificate: true,
      },
    });
    await pool.connect();
    return pool;
  }

  private async executeMSSQLQuery(
    database: IDatabaseConnection,
    query: string,
  ): Promise<QueryResult> {
    const pool = (await this.getConnection(database)) as ConnectionPool;
    try {
      const result = await pool.request().query(query);
      return {
        success: true,
        data: result.recordset,
        rowCount: result.rowsAffected[0],
      };
    } catch (error) {
      return {
        success: false,
        error: error instanceof Error ? error.message : "MSSQL query failed",
      };
    }
  }
}

// Export singleton instance
export const databaseConnectionService = new DatabaseConnectionService();

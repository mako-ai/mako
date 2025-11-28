import {
  DatabaseDriver,
  DatabaseDriverMetadata,
  DatabaseTreeNode,
} from "../../driver";
import { IDatabaseConnection } from "../../../database/workspace-schema";
import {
  Connector,
  AuthTypes,
  IpAddressTypes,
} from "@google-cloud/cloud-sql-connector";
import { Client as PgClient, Pool as PgPool } from "pg";
import { GoogleAuth, JWT, type AuthClient } from "google-auth-library";

interface QueryResult {
  success: boolean;
  data?: any;
  error?: string;
  rowCount?: number;
  fields?: any;
}

const CLOUDSQL_SCOPES = [
  "https://www.googleapis.com/auth/cloud-platform",
  "https://www.googleapis.com/auth/sqlservice.admin",
  "https://www.googleapis.com/auth/sqlservice.login",
] as const;

export class CloudSQLPostgresDatabaseDriver implements DatabaseDriver {
  private connectors: Map<string, Connector> = new Map();
  private pools: Map<string, PgPool> = new Map();

  getMetadata(): DatabaseDriverMetadata {
    return {
      type: "cloudsql-postgres",
      displayName: "Cloud SQL (Postgres)",
      consoleLanguage: "sql",
    } as any;
  }

  async getTreeRoot(
    database: IDatabaseConnection,
  ): Promise<DatabaseTreeNode[]> {
    // Single Database Mode
    if (database.connection.database) {
      const dbName = database.connection.database;
      return [
        {
          id: dbName,
          label: dbName,
          kind: "database",
          hasChildren: true,
          metadata: { databaseId: dbName, databaseName: dbName },
        },
      ];
    }

    // Cluster Mode: List all databases
    try {
      const result = await this.executeQuery(
        database,
        `SELECT datname FROM pg_database WHERE datistemplate = false ORDER BY datname;`,
      );
      if (!result.success) return [];

      const rows: Array<{ datname: string }> = result.data || [];
      return rows.map<DatabaseTreeNode>(r => ({
        id: r.datname,
        label: r.datname,
        kind: "database",
        hasChildren: true,
        metadata: { databaseId: r.datname, databaseName: r.datname },
      }));
    } catch (error) {
      console.error("Error listing databases in cluster mode:", error);
      return [];
    }
  }

  private async listSchemas(
    database: IDatabaseConnection,
    dbName?: string,
  ): Promise<DatabaseTreeNode[]> {
    const result = await this.executeQuery(
      database,
      `select schema_name from information_schema.schemata order by schema_name;`,
      { databaseName: dbName },
    );
    if (!result.success) return [];
    const systemSchemas: Record<string, true> = {
      information_schema: true,
      pg_catalog: true,
      pg_toast: true,
      pg_temp_1: true,
      pg_toast_temp_1: true,
    };
    const rows: Array<{ schema_name: string }> = result.data || [];
    return rows
      .map(r => r.schema_name)
      .filter(s => !systemSchemas[s])
      .sort((a, b) => a.localeCompare(b))
      .map<DatabaseTreeNode>(schema => ({
        id: dbName ? `${dbName}.${schema}` : schema,
        label: schema,
        kind: "schema",
        hasChildren: true,
        metadata: { schema, databaseId: dbName, databaseName: dbName },
      }));
  }

  async getChildren(
    database: IDatabaseConnection,
    parent: { kind: string; id: string; metadata?: any },
  ): Promise<DatabaseTreeNode[]> {
    // Expanding a Database Node (Cluster Mode)
    if (parent.kind === "database") {
      const dbName =
        parent.metadata?.databaseName || parent.metadata?.databaseId;
      return this.listSchemas(database, dbName);
    }

    if (parent.kind !== "schema") return [];

    const schema = parent.metadata?.schema || parent.id;
    const dbName = parent.metadata?.databaseName || parent.metadata?.databaseId;
    const safeSchema = String(schema).replace(/'/g, "''");

    const result = await this.executeQuery(
      database,
      `select table_name, table_type from information_schema.tables where table_schema = '${safeSchema}' order by table_name;`,
      { databaseName: dbName },
    );

    if (!result.success) return [];
    const rows: Array<{ table_name: string; table_type: string }> =
      result.data || [];
    return rows.map<DatabaseTreeNode>(r => ({
      id: `${dbName ? dbName + "." : ""}${schema}.${r.table_name}`,
      label: r.table_name,
      kind: r.table_type === "VIEW" ? "view" : "table",
      hasChildren: false,
      metadata: {
        schema,
        table: r.table_name,
        databaseId: dbName,
        databaseName: dbName,
      },
    }));
  }

  async executeQuery(
    database: IDatabaseConnection,
    query: string,
    options?: { databaseName?: string; databaseId?: string; dbName?: string },
  ): Promise<QueryResult> {
    try {
      // Support both databaseName and dbName for compatibility
      const targetDb = options?.databaseName || options?.dbName;
      const pool = await this.getConnection(database, targetDb);
      const result = await pool.query(query);
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
          error instanceof Error
            ? error.message
            : "Cloud SQL PostgreSQL query failed",
      };
    }
  }

  async testConnection(
    database: IDatabaseConnection,
  ): Promise<{ success: boolean; error?: string }> {
    let connector: Connector | null = null;
    let client: PgClient | null = null;
    try {
      const conn = (database.connection as any) || {};
      connector = await this._getConnector(database);

      const getOpts: any = {};
      // ... (existing options setup)
      if (conn.instanceConnectionName || conn.instance_connection_name) {
        getOpts.instanceConnectionName =
          conn.instanceConnectionName || conn.instance_connection_name;
      }
      if (conn.domainName || conn.domain_name) {
        getOpts.domainName = conn.domainName || conn.domain_name;
      }
      const requestedIpType =
        typeof conn.ipType === "string" ? conn.ipType.toUpperCase() : undefined;
      const resolvedIpType =
        requestedIpType && requestedIpType in IpAddressTypes
          ? IpAddressTypes[requestedIpType as keyof typeof IpAddressTypes]
          : undefined;
      if (resolvedIpType) {
        getOpts.ipType = resolvedIpType;
      }

      const requestedAuthType =
        typeof conn.authType === "string"
          ? conn.authType.toUpperCase()
          : undefined;
      const resolvedAuthType =
        requestedAuthType && requestedAuthType in AuthTypes
          ? AuthTypes[requestedAuthType as keyof typeof AuthTypes]
          : undefined;
      if (resolvedAuthType) {
        getOpts.authType = resolvedAuthType;
      }

      console.log("[CloudSQL] Calling connector.getOptions with:", getOpts);

      let clientOpts;
      try {
        clientOpts = await connector.getOptions(getOpts);
        console.log("[CloudSQL] Successfully got client options");
      } catch (getOptionsError) {
        console.error("[CloudSQL] Failed to get options:", getOptionsError);
        // More detailed error handling
        if (
          getOptionsError instanceof Error &&
          getOptionsError.message.includes("Login Required")
        ) {
          throw new Error(
            "Authentication failed. The service account credentials may not have the required permissions. " +
              "Please ensure the service account has 'Cloud SQL Client' role in the project.",
          );
        }
        throw getOptionsError;
      }

      let user: string | undefined = conn.username;
      if (resolvedAuthType === AuthTypes.IAM) {
        if (!user && conn.service_account_json) {
          try {
            const sa =
              typeof conn.service_account_json === "string"
                ? JSON.parse(conn.service_account_json)
                : conn.service_account_json;
            const email = sa?.client_email;
            if (email) {
              if (email.endsWith(".gserviceaccount.com")) {
                const [localPart] = email.split("@");
                const projectId =
                  sa.project_id || email.split("@")[1].split(".")[0];
                user = `${localPart}@${projectId}.iam`;
                console.log(
                  "[CloudSQL] Using IAM format for connection test:",
                  user,
                );
              } else {
                user = email;
              }
            }
          } catch (e) {
            console.error(
              "[CloudSQL] Failed to extract email from service account:",
              e,
            );
          }
        }
      }

      client = new PgClient({
        ...(clientOpts as any),
        user,
        database: conn.database || "postgres", // Default to postgres
        password: resolvedAuthType === AuthTypes.IAM ? "" : conn.password,
      });

      await client.connect();
      await client.query("SELECT 1");
      return { success: true };
    } catch (error) {
      console.error("[CloudSQL] Connection test failed:", error);
      return {
        success: false,
        error:
          error instanceof Error
            ? error.message
            : "Cloud SQL PostgreSQL connection failed",
      };
    } finally {
      if (client) {
        try {
          await client.end();
        } catch (e) {
          console.error("[CloudSQL] Error closing test client:", e);
        }
      }
      if (connector) {
        try {
          await connector.close();
        } catch (e) {
          console.error("[CloudSQL] Error closing test connector:", e);
        }
      }
    }
  }

  async getConnection(
    database: IDatabaseConnection,
    dbNameOverride?: string,
  ): Promise<PgPool> {
    const key = `${database._id.toString()}:${dbNameOverride || "default"}`;
    const existingPool = this.pools.get(key);
    if (existingPool) {
      return existingPool;
    }

    try {
      const conn = (database.connection as any) || {};
      const connector = await this._getConnector(database);

      const getOpts: any = {};
      if (conn.instanceConnectionName || conn.instance_connection_name) {
        getOpts.instanceConnectionName =
          conn.instanceConnectionName || conn.instance_connection_name;
      }
      if (conn.domainName || conn.domain_name) {
        getOpts.domainName = conn.domainName || conn.domain_name;
      }
      const requestedIpType =
        typeof conn.ipType === "string" ? conn.ipType.toUpperCase() : undefined;
      const resolvedIpType =
        requestedIpType && requestedIpType in IpAddressTypes
          ? IpAddressTypes[requestedIpType as keyof typeof IpAddressTypes]
          : undefined;
      if (resolvedIpType) {
        getOpts.ipType = resolvedIpType;
      }

      const requestedAuthType =
        typeof conn.authType === "string"
          ? conn.authType.toUpperCase()
          : undefined;
      const resolvedAuthType =
        requestedAuthType && requestedAuthType in AuthTypes
          ? AuthTypes[requestedAuthType as keyof typeof AuthTypes]
          : undefined;
      if (resolvedAuthType) {
        getOpts.authType = resolvedAuthType;
      }

      const clientOpts = await connector.getOptions(getOpts);

      let user: string | undefined = conn.username;
      if (resolvedAuthType === AuthTypes.IAM) {
        if (!user && conn.service_account_json) {
          // Try to extract email from service account JSON
          try {
            const sa =
              typeof conn.service_account_json === "string"
                ? JSON.parse(conn.service_account_json)
                : conn.service_account_json;
            const email = sa?.client_email;
            if (email) {
              // For IAM auth, if the email ends with gserviceaccount.com,
              // convert to the IAM format: name@project.iam
              if (email.endsWith(".gserviceaccount.com")) {
                const [localPart] = email.split("@");
                const projectId =
                  sa.project_id || email.split("@")[1].split(".")[0];
                user = `${localPart}@${projectId}.iam`;
                console.log(
                  "[CloudSQL] Converted service account email to IAM format:",
                  user,
                );
              } else {
                user = email;
              }
            }
          } catch (e) {
            console.error(
              "[CloudSQL] Failed to extract email from service account for pool:",
              e,
            );
          }
        }

        if (!user) {
          console.warn(
            "[CloudSQL] IAM auth selected but no username provided for pool. " +
              "Please provide username in format: service-account@project.iam",
          );
        }
      }

      // Use override if provided, otherwise config, otherwise default to postgres
      const targetDb = dbNameOverride || conn.database || "postgres";

      const pool = new PgPool({
        ...(clientOpts as any),
        user,
        database: targetDb,
        password: resolvedAuthType === AuthTypes.IAM ? "" : conn.password, // Empty password for IAM auth
        max: 5,
      });

      // Only cache if we used the connector we just got
      // Note: In this simplified driver, we might be creating a new connector instance each time _getConnector is called
      // ideally we should cache connectors too, but the existing code creates map entries based on databaseId
      // We need to be careful about key management.
      // Let's keep the connector in the map keyed by databaseId (shared across pools for same connection)
      // But wait, this.connectors key is databaseId. If we call this multiple times for different DBs, we overwrite it?
      // Actually _getConnector creates a NEW connector each time currently (except it returns if found in map? No _getConnector doesn't check map).
      // Wait, _getConnector logic:
      // It parses config and returns `new Connector(...)`. It doesn't use `this.connectors`.
      // `getConnection` sets `this.connectors.set(key, connector)`.
      // If `key` now includes dbName, we will have multiple connectors for same instance?
      // Connector is per-instance usually.
      // Let's adjust `key` logic.

      // Refined logic:
      // Connector is per database CONFIG (instance), not per DB name.
      // Pool is per DB name.

      this.connectors.set(database._id.toString(), connector);
      this.pools.set(key, pool); // key includes dbName

      return pool;
    } catch (error) {
      console.error("[CloudSQL] Failed to create connection pool:", error);
      throw new Error(
        `Failed to establish Cloud SQL connection: ${
          error instanceof Error ? error.message : "Unknown error"
        }`,
      );
    }
  }

  async closeConnection(databaseId: string): Promise<void> {
    const pool = this.pools.get(databaseId);
    if (pool) {
      await pool.end();
      this.pools.delete(databaseId);
    }
    const connector = this.connectors.get(databaseId);
    if (connector) {
      await connector.close();
      this.connectors.delete(databaseId);
    }
  }

  async closeAllConnections(): Promise<void> {
    for (const id of this.pools.keys()) {
      await this.closeConnection(id);
    }
  }

  private async _getConnector(
    database: IDatabaseConnection,
  ): Promise<Connector> {
    const conn = (database.connection as any) || {};

    // Debug logging to trace connection config
    console.log("[CloudSQL] Getting connector with config:", {
      instanceConnectionName: conn.instanceConnectionName,
      domainName: conn.domainName,
      authType: conn.authType,
      hasServiceAccount: !!conn.service_account_json,
      username: conn.username,
      database: conn.database,
      ipType: conn.ipType,
    });

    // Set up authentication
    let connectorAuth: GoogleAuth | AuthClient | undefined;

    // Check if service account JSON is provided (multi-tenant scenario)
    if (conn.service_account_json) {
      try {
        const credentials =
          typeof conn.service_account_json === "string"
            ? JSON.parse(conn.service_account_json)
            : conn.service_account_json;

        console.log("[CloudSQL] Using provided service account:", {
          type: credentials.type,
          client_email: credentials.client_email,
          project_id: credentials.project_id,
          hasPrivateKey: !!credentials.private_key,
        });

        const {
          client_email: email,
          private_key: key,
          project_id: projectId,
        } = credentials;
        if (!email || !key) {
          throw new Error(
            "Service account JSON must include client_email and private_key.",
          );
        }

        connectorAuth = new JWT({
          email,
          key,
          scopes: [...CLOUDSQL_SCOPES],
          projectId,
        });

        // Test if auth is working by trying to get an access token
        console.log("[CloudSQL] Testing auth by getting access token...");
        let authClient: AuthClient | null = null;
        try {
          authClient = connectorAuth;
          const accessTokenResponse = await authClient.getAccessToken();
          console.log("[CloudSQL] Access token obtained, auth is working", {
            hasToken: !!accessTokenResponse?.token,
            expiration: accessTokenResponse?.res?.data?.expiry_date,
          });
        } catch (authTestError) {
          console.error("[CloudSQL] Auth test failed:", authTestError);
          throw new Error(
            `Service account authentication failed: ${
              authTestError instanceof Error
                ? authTestError.message
                : "Unknown error"
            }`,
          );
        }

        if (!authClient) {
          throw new Error(
            "Auth client initialization failed even though credentials were parsed successfully.",
          );
        }
        console.log("[CloudSQL] Using JWT auth client for connector");
        const connector = new Connector({ auth: connectorAuth });
        console.log("[CloudSQL] Connector created successfully");
        return connector;
      } catch (parseError) {
        console.error(
          "[CloudSQL] Failed to parse service account JSON:",
          parseError,
        );
        throw new Error(
          `Invalid service account JSON: ${
            parseError instanceof Error ? parseError.message : "Parse error"
          }`,
        );
      }
    } else {
      // Fall back to Application Default Credentials
      console.log(
        "[CloudSQL] No service account JSON provided, using Application Default Credentials",
      );
      try {
        connectorAuth = new GoogleAuth({
          scopes: [...CLOUDSQL_SCOPES],
        });
        const authClient = await connectorAuth.getClient();
        console.log("[CloudSQL] Auth client obtained successfully");
        const tokenResponse = await authClient.getAccessToken();
        console.log("[CloudSQL] Access token obtained, auth is working", {
          hasToken: !!tokenResponse?.token,
        });
        return new Connector({ auth: connectorAuth });
      } catch (authError) {
        console.error("[CloudSQL] Failed to create auth with ADC:", authError);
        throw new Error(
          `Authentication setup failed: ${
            authError instanceof Error ? authError.message : "Unknown error"
          }. ` +
            `Please provide service account JSON or ensure GOOGLE_APPLICATION_CREDENTIALS is set.`,
        );
      }
    }
  }
}

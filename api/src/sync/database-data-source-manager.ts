import { Db, ObjectId, type Document, type WithId } from "mongodb";
import { decryptEncrypted } from "../services/crypto.service";
import * as dotenv from "dotenv";
import { syncConnectorRegistry } from "./connector-registry";
import { isWorkspaceConnectorType } from "../connectors/workspace/SandboxedConnector";
import { databaseConnectionService } from "../services/database-connection.service";
import { loggers } from "../logging";

dotenv.config({ quiet: true });

const logger = loggers.sync("source-connection-manager");

// Import connector schemas to determine which fields should be encrypted
type ConnectorFieldSchema = {
  name: string;
  type: string;
  encrypted?: boolean;
  itemFields?: ConnectorFieldSchema[];
  [key: string]: any;
};

type ConnectorSchema = { fields: ConnectorFieldSchema[] };

/**
 * Decrypted runtime config for a source connection (a credential configured
 * with a connector). Not an app's DuckDB data source (binding).
 */
export interface SourceConnectionConfig {
  id: string;
  name: string;
  description?: string;
  type: string;
  /**
   * The owning workspace. Optional only because rows predating multi-tenancy
   * may not have one; a `ws:` connector cannot be resolved without it, since
   * its code, its spec and its secret fields are all per-workspace.
   */
  workspaceId?: string;
  active: boolean;
  connection: any;
  settings: {
    sync_batch_size?: number;
    rate_limit_delay_ms?: number;
    timezone?: string;
    max_retries?: number;
    timeout_ms?: number;
  };
}

class SourceConnectionManager {
  private schemaCache: Map<string, ConnectorSchema> = new Map();
  private databaseName: string = "";
  private initialized = false;

  private initialize() {
    if (this.initialized) return;

    if (!process.env.DATABASE_URL) {
      throw new Error("DATABASE_URL environment variable is not set");
    }
    const connectionString = process.env.DATABASE_URL;

    // Extract database name from the connection string or use environment variable
    this.databaseName =
      process.env.DATABASE_NAME ||
      this.extractDatabaseName(connectionString) ||
      "mako";

    this.initialized = true;
  }

  private extractDatabaseName(connectionString: string): string | null {
    try {
      const url = new URL(connectionString);
      const pathname = url.pathname;
      if (pathname && pathname.length > 1) {
        return pathname.substring(1); // Remove leading slash
      }
    } catch {
      // Invalid URL, return null
    }
    return null;
  }

  private async getDb(): Promise<Db> {
    this.initialize();

    // Use the unified pool to get the main database connection
    const connection = await databaseConnectionService.getMainConnection();

    return connection.db;
  }

  /**
   * Get connector schema
   */
  private async getConnectorSchema(
    connectorType: string,
    workspaceId?: string,
  ): Promise<ConnectorSchema | null> {
    // A BUILT-IN connector's schema is a static method on a class that is
    // fixed for the life of the process, so caching it is free. A workspace
    // connector's is not: it is re-derived from the spec on every push, and
    // this process has no way to hear about a push. Caching it would mean
    // that after an author renames or adds a secret field, a long-lived
    // instance keeps decrypting by the field list it saw first — handing the
    // connector ciphertext, or trying to decrypt a value that was never
    // encrypted. The read behind it is one indexed Mongo lookup, which is not
    // worth being wrong about which fields are secrets.
    const workspaceConnector = isWorkspaceConnectorType(connectorType);
    const cachedSchema = workspaceConnector
      ? undefined
      : this.schemaCache.get(connectorType);
    if (cachedSchema) {
      return cachedSchema;
    }
    // Ask the connector registry for the live schema
    const schema = await syncConnectorRegistry.getConfigSchemaForType(
      connectorType,
      workspaceId,
    );
    if (schema && schema.fields) {
      if (!workspaceConnector) {
        this.schemaCache.set(connectorType, schema as ConnectorSchema);
      }
      return schema as ConnectorSchema;
    }
    logger.warn("No schema found for connector type", { connectorType });
    return null;
  }

  /** One stored `connectors` row as a decrypted source-connection config. */
  private async toConfig(
    source: WithId<Document>,
  ): Promise<SourceConnectionConfig> {
    const workspaceId = source.workspaceId
      ? String(source.workspaceId)
      : undefined;
    return {
      id: source._id.toString(),
      name: source.name,
      description: source.description,
      type: source.type,
      workspaceId,
      active: source.isActive,
      connection: await this.decryptConfig(
        source.config,
        source.type,
        workspaceId,
      ),
      settings: {
        sync_batch_size: source.settings?.sync_batch_size || 100,
        rate_limit_delay_ms: source.settings?.rate_limit_delay_ms || 200,
        timezone: source.settings?.timezone || "UTC",
        max_retries: source.settings?.max_retries || 3,
        timeout_ms: source.settings?.timeout_ms || 30000,
      },
    };
  }

  private async connectors() {
    const db = await this.getDb();
    return db.collection("connectors");
  }

  /** All active source connections, optionally in one workspace. */
  async getActiveSourceConnections(
    workspaceId?: string,
  ): Promise<SourceConnectionConfig[]> {
    const query: Record<string, unknown> = { isActive: true };
    if (workspaceId) query.workspaceId = new ObjectId(workspaceId);
    const sources = await (await this.connectors()).find(query).toArray();
    return Promise.all(sources.map(source => this.toConfig(source)));
  }

  /**
   * One source connection by id, or null. A flow's lookup passes the flow's
   * `workspaceId`: a connection of another workspace then reads as missing
   * (flow-connection-scope.ts).
   */
  async getSourceConnection(
    id: string,
    workspaceId?: string,
  ): Promise<SourceConnectionConfig | null> {
    if (!ObjectId.isValid(id)) return null;
    if (workspaceId !== undefined && !ObjectId.isValid(workspaceId)) {
      return null;
    }
    const source = await (
      await this.connectors()
    ).findOne({
      _id: new ObjectId(id),
      ...(workspaceId !== undefined
        ? { workspaceId: new ObjectId(workspaceId) }
        : {}),
    });
    return source ? this.toConfig(source) : null;
  }

  /** Active source connections of one connector type. */
  async getSourceConnectionsByType(
    type: string,
  ): Promise<SourceConnectionConfig[]> {
    const sources = await (
      await this.connectors()
    )
      .find({ type, isActive: true })
      .toArray();
    return Promise.all(sources.map(source => this.toConfig(source)));
  }

  /** Every source connection, as "name (id)". */
  async listSourceConnectionIds(): Promise<string[]> {
    const sources = await (
      await this.connectors()
    )
      .find({}, { projection: { _id: 1, name: 1 } })
      .toArray();
    return sources.map(s => `${s.name} (${s._id})`);
  }

  /** Active source connections, as "name (id)". */
  async listActiveSourceConnectionIds(): Promise<string[]> {
    const sources = await (
      await this.connectors()
    )
      .find({ isActive: true }, { projection: { _id: 1, name: 1 } })
      .toArray();
    return sources.map(s => `${s.name} (${s._id})`);
  }

  /**
   * Validate configuration (always returns valid — source connections are
   * stored rows, not a file-based config).
   */
  validateConfig(): { valid: boolean; errors: string[] } {
    // Don't initialize here, just return valid
    return { valid: true, errors: [] };
  }

  private getEncryptionKey(): string {
    const key = process.env.ENCRYPTION_KEY;
    if (!key) {
      throw new Error("ENCRYPTION_KEY environment variable is not set");
    }
    return key;
  }

  private decryptString(encryptedString: string): string {
    if (!encryptedString || !encryptedString.includes(":")) {
      return encryptedString; // Not encrypted
    }
    try {
      return decryptEncrypted(encryptedString);
    } catch (error) {
      logger.error("Decryption failed", { error });
      // Don't return the original string if decryption fails - throw error
      throw error;
    }
  }

  /**
   * Decrypt config based on connector schema
   */
  private async decryptConfig(
    config: any,
    connectorType: string,
    workspaceId?: string,
  ): Promise<any> {
    if (!config) return config;

    const schema = await this.getConnectorSchema(connectorType, workspaceId);
    if (!schema) {
      logger.warn("No schema found for connector type, skipping decryption", {
        connectorType,
      });
      // Return config as-is without decryption
      return config;
    }

    const decrypted: any = {};

    // Copy all fields
    for (const key in config) {
      decrypted[key] = config[key];
    }

    // Helper to decrypt by schema node (supports nested object_array)
    const decryptBySchema = (
      targetObj: any,
      schemaNode: ConnectorFieldSchema | ConnectorSchema,
      basePath: string = "",
    ) => {
      const fields =
        (schemaNode as ConnectorSchema).fields ||
        ((schemaNode as ConnectorFieldSchema)
          .itemFields as ConnectorFieldSchema[]) ||
        [];
      for (const fld of fields) {
        const key = fld.name;
        const value = basePath
          ? targetObj?.[basePath]?.[key]
          : targetObj?.[key];
        const setValue = (v: any) => {
          if (basePath) {
            if (!targetObj[basePath]) targetObj[basePath] = {};
            targetObj[basePath][key] = v;
          } else {
            targetObj[key] = v;
          }
        };

        if (fld.type === "object_array" && Array.isArray(value)) {
          value.forEach((item: any, idx: number) => {
            // Recurse into item using itemFields
            if (fld.itemFields && fld.itemFields.length > 0) {
              const itemRef = basePath
                ? targetObj[basePath][key][idx]
                : targetObj[key][idx];
              decryptBySchema(
                itemRef,
                { fields: fld.itemFields } as ConnectorSchema,
                "",
              );
            }
          });
          continue;
        }

        if (fld.encrypted || fld.type === "password") {
          const raw = value;
          if (typeof raw === "string" && raw) {
            try {
              const dec = this.decryptString(raw);
              setValue(dec);
            } catch (error) {
              logger.error("Failed to decrypt field", { field: key, error });
              setValue(raw);
            }
          }
        }
      }
    };

    decryptBySchema(decrypted, schema as ConnectorSchema);

    return decrypted;
  }

  private decryptObject(obj: any): any {
    if (!obj) return obj;

    const decrypted: any = {};
    for (const key in obj) {
      if (typeof obj[key] === "string" && obj[key]) {
        decrypted[key] = this.decryptString(obj[key]);
      } else if (typeof obj[key] === "object" && obj[key] !== null) {
        decrypted[key] = this.decryptObject(obj[key]);
      } else {
        decrypted[key] = obj[key];
      }
    }
    return decrypted;
  }
}

// Export singleton instance with lazy initialization
let _sourceConnectionManager: SourceConnectionManager | null = null;
export function getSourceConnectionManager(): SourceConnectionManager {
  if (!_sourceConnectionManager) {
    _sourceConnectionManager = new SourceConnectionManager();
  }
  return _sourceConnectionManager;
}

function proxyManager() {
  return {
    get instance() {
      return getSourceConnectionManager();
    },
    async getActiveSourceConnections(workspaceId?: string) {
      return getSourceConnectionManager().getActiveSourceConnections(
        workspaceId,
      );
    },
    async getSourceConnection(id: string, workspaceId?: string) {
      return getSourceConnectionManager().getSourceConnection(id, workspaceId);
    },
    async getSourceConnectionsByType(type: string) {
      return getSourceConnectionManager().getSourceConnectionsByType(type);
    },
    async listSourceConnectionIds() {
      return getSourceConnectionManager().listSourceConnectionIds();
    },
    async listActiveSourceConnectionIds() {
      return getSourceConnectionManager().listActiveSourceConnectionIds();
    },
    validateConfig() {
      return getSourceConnectionManager().validateConfig();
    },
  };
}

export const sourceConnectionManager = proxyManager();

export { SourceConnectionManager };

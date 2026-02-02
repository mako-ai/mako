import { Db, ObjectId } from "mongodb";
import * as crypto from "crypto";
import * as dotenv from "dotenv";
import { syncConnectorRegistry } from "./connector-registry";
import { databaseConnectionService } from "../services/database-connection.service";
import { loggers } from "../logging";

dotenv.config();

const logger = loggers.sync("data-source-manager");

// Import connector schemas to determine which fields should be encrypted
type ConnectorFieldSchema = {
  name: string;
  type: string;
  encrypted?: boolean;
  itemFields?: ConnectorFieldSchema[];
  [key: string]: any;
};

type ConnectorSchema = { fields: ConnectorFieldSchema[] };

// Data source interface matching the database schema
export interface DataSourceConfig {
  id: string;
  name: string;
  description?: string;
  type: string;
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

class DatabaseDataSourceManager {
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
  ): Promise<ConnectorSchema | null> {
    const cachedSchema = this.schemaCache.get(connectorType);
    if (cachedSchema) {
      return cachedSchema;
    }
    // Ask the connector registry for the live schema
    const schema =
      await syncConnectorRegistry.getConfigSchemaForType(connectorType);
    if (schema && schema.fields) {
      this.schemaCache.set(connectorType, schema as ConnectorSchema);
      return schema as ConnectorSchema;
    }
    logger.warn("No schema found for connector type", { connectorType });
    return null;
  }

  /**
   * Get all active data sources
   */
  async getActiveDataSources(
    workspaceId?: string,
  ): Promise<DataSourceConfig[]> {
    const db = await this.getDb();
    const collection = db.collection("connectors");

    const query: any = { isActive: true };
    if (workspaceId) {
      query.workspaceId = new ObjectId(workspaceId);
    }

    const sources = await collection.find(query).toArray();

    const results = [];
    for (const source of sources) {
      results.push({
        id: source._id.toString(),
        name: source.name,
        description: source.description,
        type: source.type,
        active: source.isActive,
        connection: await this.decryptConfig(source.config, source.type),
        settings: {
          sync_batch_size: source.settings?.sync_batch_size || 100,
          rate_limit_delay_ms: source.settings?.rate_limit_delay_ms || 200,
          timezone: source.settings?.timezone || "UTC",
          max_retries: source.settings?.max_retries || 3,
          timeout_ms: source.settings?.timeout_ms || 30000,
        },
      });
    }

    return results;
  }

  /**
   * Get a specific data source by ID or name
   */
  async getDataSource(id: string): Promise<DataSourceConfig | null> {
    const db = await this.getDb();
    const collection = db.collection("connectors");

    if (!ObjectId.isValid(id)) {
      return null;
    }

    // Try to find by ID first
    const source = await collection.findOne({ _id: new ObjectId(id) });

    if (!source) {
      return null;
    }

    return {
      id: source._id.toString(),
      name: source.name,
      description: source.description,
      type: source.type,
      active: source.isActive,
      connection: await this.decryptConfig(source.config, source.type),
      settings: {
        sync_batch_size: source.settings?.sync_batch_size || 100,
        rate_limit_delay_ms: source.settings?.rate_limit_delay_ms || 200,
        timezone: source.settings?.timezone || "UTC",
        max_retries: source.settings?.max_retries || 3,
        timeout_ms: source.settings?.timeout_ms || 30000,
      },
    };
  }

  /**
   * Get data sources by type
   */
  async getDataSourcesByType(type: string): Promise<DataSourceConfig[]> {
    const db = await this.getDb();
    const collection = db.collection("connectors");

    const sources = await collection.find({ type, isActive: true }).toArray();

    const results = [];
    for (const source of sources) {
      results.push({
        id: source._id.toString(),
        name: source.name,
        description: source.description,
        type: source.type,
        active: source.isActive,
        connection: await this.decryptConfig(source.config, source.type),
        settings: {
          sync_batch_size: source.settings?.sync_batch_size || 100,
          rate_limit_delay_ms: source.settings?.rate_limit_delay_ms || 200,
          timezone: source.settings?.timezone || "UTC",
          max_retries: source.settings?.max_retries || 3,
          timeout_ms: source.settings?.timeout_ms || 30000,
        },
      });
    }

    return results;
  }

  /**
   * List all data source IDs
   */
  async listDataSourceIds(): Promise<string[]> {
    const db = await this.getDb();
    const collection = db.collection("connectors");

    const sources = await collection
      .find({}, { projection: { _id: 1, name: 1 } })
      .toArray();

    return sources.map(s => `${s.name} (${s._id})`);
  }

  /**
   * List active data source IDs
   */
  async listActiveDataSourceIds(): Promise<string[]> {
    const db = await this.getDb();
    const collection = db.collection("connectors");

    const sources = await collection
      .find({ isActive: true }, { projection: { _id: 1, name: 1 } })
      .toArray();

    return sources.map(s => `${s.name} (${s._id})`);
  }

  /**
   * Validate configuration (always returns valid for database sources)
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
      const textParts = encryptedString.split(":");
      const iv = Buffer.from(textParts[0], "hex");
      const encryptedText = Buffer.from(textParts.slice(1).join(":"), "hex");

      const decipher = crypto.createDecipheriv(
        "aes-256-cbc",
        Buffer.from(this.getEncryptionKey(), "hex"),
        iv,
      );

      let decrypted = decipher.update(encryptedText);
      decrypted = Buffer.concat([decrypted, decipher.final()]);

      return decrypted.toString();
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
  ): Promise<any> {
    if (!config) return config;

    const schema = await this.getConnectorSchema(connectorType);
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
let _databaseDataSourceManager: DatabaseDataSourceManager | null = null;
export function getDatabaseDataSourceManager(): DatabaseDataSourceManager {
  if (!_databaseDataSourceManager) {
    _databaseDataSourceManager = new DatabaseDataSourceManager();
  }
  return _databaseDataSourceManager;
}

// For backward compatibility, export a getter that returns the instance
export const databaseDataSourceManager = {
  get instance() {
    return getDatabaseDataSourceManager();
  },
  // Proxy all methods to the singleton
  async getActiveDataSources(workspaceId?: string) {
    return getDatabaseDataSourceManager().getActiveDataSources(workspaceId);
  },
  async getDataSource(id: string) {
    return getDatabaseDataSourceManager().getDataSource(id);
  },
  async getDataSourcesByType(type: string) {
    return getDatabaseDataSourceManager().getDataSourcesByType(type);
  },
  async listDataSourceIds() {
    return getDatabaseDataSourceManager().listDataSourceIds();
  },
  async listActiveDataSourceIds() {
    return getDatabaseDataSourceManager().listActiveDataSourceIds();
  },
  validateConfig() {
    return getDatabaseDataSourceManager().validateConfig();
  },
};

// Export class for custom instances
export { DatabaseDataSourceManager };

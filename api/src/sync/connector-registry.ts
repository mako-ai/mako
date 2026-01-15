import { DataSourceConfig } from "./database-data-source-manager";
import { BaseConnector } from "../connectors/base/BaseConnector";
import * as fs from "fs";
import * as path from "path";
import { loggers } from "../logging";

const logger = loggers.sync("connector-registry");

interface ConnectorRegistryEntry {
  type: string;
  connectorClass: any;
  metadata: {
    name: string;
    version: string;
    description: string;
    supportedEntities: string[];
  };
}

/**
 * Connector registry for the sync script
 * Dynamically loads connectors based on connector type
 */
class SyncConnectorRegistry {
  private connectors: Map<string, ConnectorRegistryEntry> = new Map();
  private initialized = false;

  constructor() {
    void this.initializeConnectors();
  }

  /**
   * Get config schema for a connector type by calling its static getConfigSchema()
   */
  async getConfigSchemaForType(type: string): Promise<any | null> {
    let entry = this.connectors.get(type);
    if (!entry) {
      // Attempt lazy load
      try {
        const mod = await import(`../connectors/${type}`);
        const exportKey = Object.keys(mod).find(k => k.endsWith("Connector"));
        if (!exportKey) return null;
        const connectorClass = (mod as any)[exportKey];
        entry = {
          type,
          connectorClass,
          metadata: {
            name: type,
            version: "1.0.0",
            description: `${type} connector`,
            supportedEntities: [],
          },
        };
        this.register(entry);
      } catch {
        return null;
      }
    }

    try {
      const schema = (entry as any).connectorClass?.getConfigSchema?.();
      return schema || null;
    } catch {
      return null;
    }
  }
  /**
   * Discover and register connectors by scanning the connectors directory
   */
  private async initializeConnectors() {
    if (this.initialized) return;

    try {
      const connectorsDir = path.join(__dirname, "../connectors");
      const entries = fs.readdirSync(connectorsDir, { withFileTypes: true });
      const connectorDirs = entries
        .filter(entry => entry.isDirectory() && entry.name !== "base")
        .map(entry => entry.name);

      for (const dirName of connectorDirs) {
        const dirPath = path.join(connectorsDir, dirName);
        const hasConnector = [
          "connector.ts",
          "connector.js",
          "index.ts",
          "index.js",
        ].some(f => fs.existsSync(path.join(dirPath, f)));
        if (!hasConnector) {
          // Skip empty or non-connector folders (like temporary dirs)
          continue;
        }
        try {
          // Dynamically import the connector module
          const modulePath = `../connectors/${dirName}`;
          const mod = await import(modulePath);
          const exportKey = Object.keys(mod).find(k => k.endsWith("Connector"));
          if (!exportKey) {
            logger.warn("No Connector class export found", { dirName });
            continue;
          }
          const connectorClass = (mod as any)[exportKey];

          // Try to get metadata
          let metadata = {
            name: dirName.charAt(0).toUpperCase() + dirName.slice(1),
            version: "1.0.0",
            description: `${dirName} connector`,
            supportedEntities: [],
          };
          try {
            const temp = new connectorClass({ config: {} } as any);
            if (typeof temp.getMetadata === "function") {
              metadata = temp.getMetadata();
            }
          } catch {
            // ignore, fallback to default metadata
          }

          this.register({ type: dirName, connectorClass, metadata });
        } catch (err) {
          logger.warn("Failed to load connector", { dirName, error: err });
        }
      }

      this.initialized = true;
    } catch (error) {
      logger.error("Failed to initialize sync connector registry", { error });
    }
  }

  /**
   * Register a connector
   */
  register(entry: ConnectorRegistryEntry) {
    this.connectors.set(entry.type, entry);
  }

  /**
   * Get a connector instance for a data source
   */
  async getConnector(
    dataSource: DataSourceConfig,
  ): Promise<BaseConnector | null> {
    let entry = this.connectors.get(dataSource.type);
    if (!entry) {
      // Attempt lazy load by type name (directory)
      try {
        const mod = await import(`../connectors/${dataSource.type}`);
        const exportKey = Object.keys(mod).find(k => k.endsWith("Connector"));
        if (exportKey) {
          const connectorClass = (mod as any)[exportKey];
          let metadata = {
            name: dataSource.type,
            version: "1.0.0",
            description: `${dataSource.type} connector`,
            supportedEntities: [],
          };
          try {
            const temp = new connectorClass({ config: {} } as any);
            if (typeof temp.getMetadata === "function") {
              metadata = temp.getMetadata();
            }
          } catch {
            // ignore metadata fetch errors
          }
          entry = { type: dataSource.type, connectorClass, metadata };
          this.register(entry);
        }
      } catch {
        logger.error("Unknown connector type", { type: dataSource.type });
        return null;
      }
    }

    // If somehow no class yet, try to import by convention
    if (!entry || !entry.connectorClass) {
      try {
        const mod = await import(`../connectors/${dataSource.type}`);
        const exportKey = Object.keys(mod).find(k => k.endsWith("Connector"));
        if (exportKey) {
          const klass = (mod as any)[exportKey];
          if (!entry) {
            entry = {
              type: dataSource.type,
              connectorClass: klass,
              metadata: {
                name: dataSource.type,
                version: "1.0.0",
                description: `${dataSource.type} connector`,
                supportedEntities: [],
              },
            };
            this.register(entry);
          } else {
            entry.connectorClass = klass;
          }
        } else {
          throw new Error("No Connector export found");
        }
      } catch (error) {
        logger.error("Failed to load connector", {
          type: dataSource.type,
          error,
        });
        return null;
      }
    }

    // Transform the data source to match what the connector expects
    const connectorDataSource = {
      _id: dataSource.id,
      name: dataSource.name,
      type: dataSource.type,
      config: dataSource.connection,
      settings: dataSource.settings,
    };

    return new entry.connectorClass(connectorDataSource);
  }

  /**
   * Check if a connector type is registered
   */
  hasConnector(type: string): boolean {
    return this.connectors.has(type);
  }

  /**
   * Get all available connector types
   */
  getAvailableTypes(): string[] {
    return Array.from(this.connectors.keys());
  }

  /**
   * Get metadata for a connector type
   */
  getMetadata(type: string): ConnectorRegistryEntry | null {
    return this.connectors.get(type) || null;
  }

  /**
   * Get supported entities for a connector type
   */
  getSupportedEntities(type: string): string[] {
    const entry = this.connectors.get(type);
    return entry?.metadata.supportedEntities || [];
  }
}

// Export singleton instance
export const syncConnectorRegistry = new SyncConnectorRegistry();

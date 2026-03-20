import { BaseConnector } from "./base/BaseConnector";
import { IConnector } from "../database/workspace-schema";
import * as fs from "fs";
import * as path from "path";
import { loggers } from "../logging";

const logger = loggers.connector();

// Type for connector constructor
type ConnectorConstructor = new (dataSource: IConnector) => BaseConnector;

// Updated metadata interface
interface ConnectorRegistryMetadata {
  type: string;
  connector: ConnectorConstructor;
  metadata: {
    name: string;
    version: string;
    description: string;
    author?: string;
    supportedEntities: string[];
    supportsCdc?: boolean;
  };
}

/**
 * Connector Registry
 * Dynamically discovers and manages all available data source connectors
 */
class ConnectorRegistry {
  private connectors: Map<string, ConnectorRegistryMetadata> = new Map();
  private initialized = false;
  private initPromise: Promise<void> | null = null;

  constructor() {
    void this.ensureInitialized();
  }

  /**
   * Dynamically discover and register connectors by scanning the connectors directory
   */
  private async initializeConnectors() {
    if (this.initialized) return;

    const connectorsDir = __dirname;

    try {
      // Get all subdirectories (potential connector folders)
      const entries = fs.readdirSync(connectorsDir, { withFileTypes: true });
      const excludedDirectories = new Set(["base", "template"]);
      const connectorDirs = entries
        .filter(
          entry => entry.isDirectory() && !excludedDirectories.has(entry.name),
        )
        .map(entry => entry.name);

      logger.info("Discovering connectors", { directory: connectorsDir });
      logger.info("Found potential connector directories", {
        directories: connectorDirs,
      });

      for (const dirName of connectorDirs) {
        try {
          await this.loadConnector(dirName);
        } catch (error) {
          logger.warn("Failed to load connector", { dirName, error });
        }
      }

      this.initialized = true;
      logger.info("Connector registry initialized", {
        connectorCount: this.connectors.size,
      });
    } catch (error) {
      logger.error("Failed to initialize connector registry", { error });
    }
  }

  /**
   * Ensure connector discovery has completed before reading metadata.
   * This avoids cold-start races where routes read an empty registry and
   * incorrectly mark all connectors as non-CDC.
   */
  async ensureInitialized(): Promise<void> {
    if (this.initialized) return;
    if (!this.initPromise) {
      this.initPromise = this.initializeConnectors().finally(() => {
        this.initPromise = null;
      });
    }
    await this.initPromise;
  }

  /**
   * Load a connector from a directory
   */
  private async loadConnector(dirName: string) {
    const connectorPath = path.join(__dirname, dirName);

    // Check if connector.ts/js exists
    const connectorFiles = ["connector.ts", "connector.js"];
    let connectorFile = null;

    for (const file of connectorFiles) {
      const filePath = path.join(connectorPath, file);
      if (fs.existsSync(filePath)) {
        connectorFile = filePath;
        break;
      }
    }

    if (!connectorFile) {
      // Fall back to index.ts/js for backwards compatibility
      const indexFiles = ["index.ts", "index.js"];
      for (const file of indexFiles) {
        const filePath = path.join(connectorPath, file);
        if (fs.existsSync(filePath)) {
          connectorFile = filePath;
          break;
        }
      }
    }

    // Skip directories without a connector or index entry
    if (!connectorFile) {
      logger.warn("Skipping directory, no connector file found", { dirName });
      return;
    }

    try {
      // Dynamically import the connector
      const connectorModule = await import(`./${dirName}`);

      // Look for any exported class ending with "Connector"
      const exports = Object.keys(connectorModule);
      const connectorExport = exports.find(key => key.endsWith("Connector"));

      if (!connectorExport) {
        logger.warn("No connector class found in directory", { dirName });
        return;
      }

      const ConnectorClass = connectorModule[connectorExport];
      logger.info("Found connector class", {
        connectorClass: connectorExport,
        dirName,
      });

      // Create a dummy data source to get metadata
      const dummyDataSource = {
        _id: "dummy",
        name: "dummy",
        type: dirName,
        config: {},
        settings: {},
      } as unknown as IConnector;

      let metadata;
      try {
        const tempConnector = new ConnectorClass(dummyDataSource);
        metadata = tempConnector.getMetadata();
      } catch {
        // If constructor fails, try to get static metadata
        metadata = {
          name: dirName.charAt(0).toUpperCase() + dirName.slice(1),
          version: "1.0.0",
          description: `${dirName} connector`,
          supportedEntities: [],
          supportsCdc: false,
        };
      }

      // Register the connector
      this.register({
        type: dirName,
        connector: ConnectorClass,
        metadata,
      });

      logger.info("Loaded connector", { dirName, name: metadata.name });
    } catch (error) {
      logger.error("Failed to import connector", { dirName, error });
    }
  }

  /**
   * Register a new connector
   */
  register(metadata: ConnectorRegistryMetadata) {
    this.connectors.set(metadata.type, metadata);
  }

  /**
   * Get a connector instance for a data source
   */
  getConnector(dataSource: IConnector): BaseConnector | null {
    const metadata = this.connectors.get(dataSource.type);
    if (!metadata) {
      return null;
    }

    const ConnectorClass = metadata.connector;
    return new ConnectorClass(dataSource);
  }

  /**
   * Get all registered connector types
   */
  getAvailableTypes(): string[] {
    return Array.from(this.connectors.keys());
  }

  /**
   * Get metadata for a connector type
   */
  getMetadata(type: string): ConnectorRegistryMetadata | null {
    return this.connectors.get(type) || null;
  }

  /**
   * Get all connector metadata
   */
  getAllMetadata(): ConnectorRegistryMetadata[] {
    return Array.from(this.connectors.values());
  }

  /**
   * Check if a connector type is registered
   */
  hasConnector(type: string): boolean {
    return this.connectors.has(type);
  }

  /**
   * Force re-initialization (useful for development)
   */
  async reinitialize() {
    this.connectors.clear();
    this.initialized = false;
    this.initPromise = null;
    await this.ensureInitialized();
  }
}

// Export singleton instance
export const connectorRegistry = new ConnectorRegistry();

// Export class for testing
export { ConnectorRegistry };

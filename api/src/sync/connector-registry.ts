import { SourceConnectionConfig } from "./database-data-source-manager";
import { BaseConnector } from "../connectors/base/BaseConnector";
import * as fs from "fs";
import * as path from "path";
import { loggers } from "../logging";
import type { ISourceConnection } from "../database/workspace-schema";
import {
  isWorkspaceConnectorType,
  SandboxedConnector,
  slugFromType,
} from "../connectors/workspace/SandboxedConnector";
import { loadConnectorDefinition } from "../connectors/workspace/resolver";
import { connectionSpecificationToForm } from "../connectors/workspace/spec-translation";

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
 * The manager's shape → the shape every connector is constructed from.
 *
 * `SourceConnectionConfig` calls the credential `connection`; a connector
 * reads it as `config`. One function does the mapping for both the built-in
 * and the workspace branch on purpose: when they each did it themselves, the
 * workspace branch handed the raw row straight to `SandboxedConnector`, which
 * then found no `config` and no `workspaceId` and could not run at all.
 */
function asSourceConnection(
  connection: SourceConnectionConfig,
): ISourceConnection {
  return {
    _id: connection.id,
    name: connection.name,
    type: connection.type,
    config: connection.connection,
    settings: connection.settings,
    workspaceId: connection.workspaceId,
  } as unknown as ISourceConnection;
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
   *
   * THIS IS A SECURITY PATH, not just a form. `applySchemaEncryption` uses the
   * returned field list to decide which values are secrets, and a null schema
   * means every value is stored in plaintext. So a workspace connector must be
   * resolved here properly — falling through to the directory import below
   * would look for `../connectors/ws:acme`, fail, return null, and silently
   * store the customer's API key unencrypted.
   *
   * A workspace connector's schema is per-workspace, hence `workspaceId`:
   * two workspaces may each have a connector called `ws:acme` with different
   * fields, and answering from a global cache would encrypt by the wrong one.
   */
  async getConfigSchemaForType(
    type: string,
    workspaceId?: string,
  ): Promise<any | null> {
    if (isWorkspaceConnectorType(type)) {
      if (!workspaceId) {
        throw new Error(
          `Resolving the config schema for "${type}" needs a workspaceId. ` +
            `Without one, secret fields cannot be identified and the credential would be stored in plaintext.`,
        );
      }
      const definition = await loadConnectorDefinition(
        workspaceId,
        slugFromType(type),
      );
      return connectionSpecificationToForm(
        (definition.spec as any)?.connectionSpecification,
      );
    }

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
   * Instantiate connector *code* for a source *connection* (credential).
   */
  async getConnectorFor(
    connection: SourceConnectionConfig,
  ): Promise<BaseConnector | null> {
    if (isWorkspaceConnectorType(connection.type)) {
      if (!connection.workspaceId) {
        throw new Error(
          `Resolving the connector for "${connection.type}" needs a workspaceId on the connection; ` +
            `a workspace connector cannot be resolved globally.`,
        );
      }
      const connector = new SandboxedConnector(asSourceConnection(connection));
      // Load the index row before handing the connector out. This path is
      // async and its callers go on to ask `getAvailableEntities()`, which is
      // synchronous by contract and would otherwise answer "no entities" for a
      // connector that has them.
      await connector.loadDefinition();
      return connector;
    }

    let entry = this.connectors.get(connection.type);
    if (!entry) {
      // Attempt lazy load by type name (directory)
      try {
        const mod = await import(`../connectors/${connection.type}`);
        const exportKey = Object.keys(mod).find(k => k.endsWith("Connector"));
        if (exportKey) {
          const connectorClass = (mod as any)[exportKey];
          let metadata = {
            name: connection.type,
            version: "1.0.0",
            description: `${connection.type} connector`,
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
          entry = { type: connection.type, connectorClass, metadata };
          this.register(entry);
        }
      } catch {
        logger.error("Unknown connector type", { type: connection.type });
        return null;
      }
    }

    // If somehow no class yet, try to import by convention
    if (!entry || !entry.connectorClass) {
      try {
        const mod = await import(`../connectors/${connection.type}`);
        const exportKey = Object.keys(mod).find(k => k.endsWith("Connector"));
        if (exportKey) {
          const klass = (mod as any)[exportKey];
          if (!entry) {
            entry = {
              type: connection.type,
              connectorClass: klass,
              metadata: {
                name: connection.type,
                version: "1.0.0",
                description: `${connection.type} connector`,
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
          type: connection.type,
          error,
        });
        return null;
      }
    }

    return new entry.connectorClass(asSourceConnection(connection));
  }

  /** @deprecated use getConnectorFor */
  async getConnector(
    dataSource: SourceConnectionConfig,
  ): Promise<BaseConnector | null> {
    return this.getConnectorFor(dataSource);
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

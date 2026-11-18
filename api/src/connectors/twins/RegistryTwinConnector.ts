/**
 * A connection of a deleted built-in type (`close`, `stripe`, …), run as its
 * folder twin in a box.
 *
 * The stored connection keeps its type, so existing connections and flows
 * need no data migration. Inside, the connector is an ordinary
 * `SandboxedConnector` on the same connection read as `ws:<type>`: the same
 * id, workspace, settings and decrypted credential, exactly as the boxed
 * switch (rfcs/connector-runtime.md §10.1) runs a switched flow. Only where
 * the definition comes from differs (./resolve.ts).
 */
import type { ISourceConnection } from "../../database/workspace-schema";
import { SandboxedConnector } from "../workspace/SandboxedConnector";
import type { LoadedConnector } from "../workspace/resolver";
import { BUILTIN_TWIN_CATALOG } from "./builtin-catalog";
import { loadTwinDefinition } from "./resolve";
import {
  isBuiltinTwinType,
  twinWorkspaceType,
  type BuiltinTwinType,
} from "./types";

export class RegistryTwinConnector extends SandboxedConnector {
  /** The type stored on the connection: `close`, not `ws:close`. */
  readonly builtinType: BuiltinTwinType;

  constructor(connection: ISourceConnection) {
    if (!isBuiltinTwinType(connection.type)) {
      throw new Error(
        `"${connection.type}" is not a built-in type with a registry twin.`,
      );
    }
    super({
      ...(connection as unknown as Record<string, unknown>),
      type: twinWorkspaceType(connection.type),
    } as unknown as ISourceConnection);
    this.builtinType = connection.type;
  }

  protected override async definition(): Promise<LoadedConnector> {
    if (!this.loaded) {
      const workspaceId = (this.sourceConnection as { workspaceId?: unknown })
        .workspaceId;
      if (!workspaceId) {
        throw new Error(
          `The "${this.builtinType}" connector runs in a box and needs a workspaceId on its connection.`,
        );
      }
      this.loaded = await loadTwinDefinition(
        String(workspaceId),
        this.builtinType,
      );
    }
    return this.loaded;
  }

  /**
   * Only the keys the twin's spec declares reach the box. A built-in kept
   * settings its folder has no use for (Stripe's `api_base_url`), and an
   * undeclared key is never the folder's to read.
   */
  protected override config(): Record<string, unknown> {
    const all = super.config();
    const properties = (
      this.loaded?.spec?.connectionSpecification as
        { properties?: Record<string, unknown> } | undefined
    )?.properties;
    if (!properties) return all;
    return Object.fromEntries(
      Object.entries(all).filter(([key]) =>
        Object.prototype.hasOwnProperty.call(properties, key),
      ),
    );
  }

  /** Load the definition first, so the check runs with the filtered config. */
  override async testConnection() {
    try {
      await this.definition();
    } catch (error) {
      return {
        success: false,
        message: error instanceof Error ? error.message : String(error),
      };
    }
    return super.testConnection();
  }

  /**
   * Before the definition loads, answer with the entities the built-in
   * declared, so a synchronous caller never sees an empty connector.
   */
  override getAvailableEntities(): string[] {
    return this.loaded
      ? super.getAvailableEntities()
      : [...BUILTIN_TWIN_CATALOG[this.builtinType].metadata.supportedEntities];
  }

  override getMetadata(): ReturnType<SandboxedConnector["getMetadata"]> {
    if (this.loaded) return super.getMetadata();
    return { ...BUILTIN_TWIN_CATALOG[this.builtinType].metadata };
  }
}

const classes = new Map<BuiltinTwinType, typeof RegistryTwinConnector>();

/**
 * One class per type, each with the static `getConfigSchema()` the deleted
 * built-in had. Callers that resolve a form or a secret field list by the
 * class (routes/connectors.ts, sync/connector-registry.ts) keep working, and
 * stored credentials decrypt by the exact field list they were encrypted by.
 */
export function registryTwinClass(
  type: BuiltinTwinType,
): typeof RegistryTwinConnector & { getConfigSchema(): unknown } {
  let klass = classes.get(type);
  if (!klass) {
    const schema = BUILTIN_TWIN_CATALOG[type].configSchema;
    klass = class extends RegistryTwinConnector {
      static getConfigSchema() {
        return structuredClone(schema);
      }
    };
    Object.defineProperty(klass, "name", {
      value: BUILTIN_TWIN_CATALOG[type].className,
    });
    classes.set(type, klass);
  }
  return klass as typeof RegistryTwinConnector & { getConfigSchema(): unknown };
}

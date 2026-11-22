/**
 * A profile with `connection` (custom_api) as a connector class, for the two
 * connector registries. With it the type keeps its catalog entry, form
 * schema, enable, edit, probe and Test exactly as its deleted connector
 * folder gave them, and is no orphan. It has no entities and never syncs.
 */
import {
  BaseConnector,
  type ConnectionTestResult,
  type FetchOptions,
} from "../../connectors/base/BaseConnector";
import type { ISourceConnection } from "../../database/workspace-schema";
import {
  connectionProfileFor,
  connectionProfiles,
  type CallableProfile,
} from ".";

type ProfileConnectorClass = (new (
  connection: ISourceConnection,
) => BaseConnector) & {
  getConfigSchema(): CallableProfile["configSchema"];
};

const classes = new Map<string, ProfileConnectorClass>();

function connectorClassOf(profile: CallableProfile): ProfileConnectorClass {
  const cached = classes.get(profile.type);
  if (cached) return cached;
  if (!profile.connection) {
    throw new Error(`${profile.type} has no connection to wrap`);
  }
  const connection: NonNullable<CallableProfile["connection"]> =
    profile.connection;
  class ProfileConnector extends BaseConnector {
    static getConfigSchema() {
      return profile.configSchema;
    }

    getMetadata() {
      return {
        name: connection.name,
        version: "1.0.0",
        description: connection.description,
        supportedEntities: [],
      };
    }

    testConnection(): Promise<ConnectionTestResult> {
      return connection.test(this.sourceConnection);
    }

    getAvailableEntities(): string[] {
      return [];
    }

    async fetchEntity(_options: FetchOptions): Promise<void> {
      throw new Error(
        `A ${connection.name} connection is never synced. Call it from a workflow with connection(id).`,
      );
    }
  }
  classes.set(profile.type, ProfileConnector);
  return ProfileConnector;
}

/** The connector class of a profile with `connection`, or null. */
export function profileConnectorClass(
  type: string,
): ProfileConnectorClass | null {
  const profile = connectionProfileFor(type);
  return profile ? connectorClassOf(profile) : null;
}

/** Every profile with `connection`, as its type and connector class. */
export function profileConnectorClasses(): {
  type: string;
  connectorClass: ProfileConnectorClass;
}[] {
  return connectionProfiles().map(profile => ({
    type: profile.type,
    connectorClass: connectorClassOf(profile),
  }));
}

/**
 * The registry of built-in connection types Mako can call: one data file per
 * type, each holding the call profile (base URL, credential, what reads), the
 * named read operations and the config schema with its secret fields.
 *
 * callable.ts and operations.ts read from here; they keep no type-specific
 * entry. The schema is read by the paths that must tell a secret from a plain
 * value (decryptConfig, config edits, the proxy). A type listed here is never
 * thereby a connector: `isOrphanConnectorType(type, ws)` without `callable`
 * still counts it as an orphan when its connector folder is gone, so
 * enabling, probing, retyping, flows, entities and the connector registry
 * never see it.
 *
 * The exception is a profile with `connection` (custom_api): a type people
 * create, edit and Test from the form with no connector folder. Both
 * connector registries wrap it (profile-connector.ts), so it is no orphan.
 *
 * Nothing imported is used while a profile file loads (callable.ts and
 * operations.ts import this registry, and the profiles import them back):
 * operations are built on first use.
 */
import type { ConnectionTestResult } from "../../connectors/base/BaseConnector";
import type { ISourceConnection } from "../../database/workspace-schema";
import type { CallableConnection } from "../callable";
import type { ConnectionOperation } from "../operations";
import { closeProfile } from "./close";
import { customApiProfile } from "./custom-api";
import { posthogProfile } from "./posthog";
import { stripeProfile } from "./stripe";
import { wiseProfile } from "./wise";

export interface CallableProfile {
  type: string;
  callable: CallableConnection;
  operations(): ConnectionOperation[];
  configSchema: {
    fields: ReadonlyArray<Record<string, unknown>>;
    [key: string]: unknown;
  };
  /**
   * Set on a type that is created and Tested from the form without a
   * connector folder. Never synced: it has no entities.
   */
  connection?: {
    name: string;
    description: string;
    test(connection: ISourceConnection): Promise<ConnectionTestResult>;
  };
}

// Looked up on use, not at load, for the import cycle above.
function profileFor(type: string): CallableProfile | null {
  switch (type) {
    case closeProfile.type:
      return closeProfile;
    case customApiProfile.type:
      return customApiProfile;
    case posthogProfile.type:
      return posthogProfile;
    case stripeProfile.type:
      return stripeProfile;
    case wiseProfile.type:
      return wiseProfile;
    default:
      return null;
  }
}

/** The profiles with `connection`: types created without a connector folder. */
export function connectionProfiles(): CallableProfile[] {
  return [
    closeProfile,
    customApiProfile,
    posthogProfile,
    stripeProfile,
    wiseProfile,
  ].filter(profile => profile.connection);
}

/** The profile of `type` when it has `connection`, or null. */
export function connectionProfileFor(type: string): CallableProfile | null {
  const profile = profileFor(type);
  return profile?.connection ? profile : null;
}

/** How Mako calls a connection of `type`, or null when it cannot yet. */
export function callableProfileFor(type: string): CallableConnection | null {
  return profileFor(type)?.callable ?? null;
}

export function callableProfileOperations(type: string): ConnectionOperation[] {
  return profileFor(type)?.operations() ?? [];
}

/** The config schema of a callable type, or null. */
export function callableProfileSchemaFor(
  type: string,
): CallableProfile["configSchema"] | null {
  return profileFor(type)?.configSchema ?? null;
}

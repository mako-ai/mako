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
 * Nothing imported is used while a profile file loads (callable.ts and
 * operations.ts import this registry, and the profiles import them back):
 * operations are built on first use.
 */
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

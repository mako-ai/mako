/**
 * The switch for the connector registry and install by reference (RFC
 * connector-runtime §7, iteration 4).
 *
 * Off by default. Off means exactly the behaviour before the registry: the
 * parser ignores a `source:` key as it ignored any unknown key, the push
 * reconciler never reads the registry, the run path never fetches a registry
 * bundle, and the agent tools list no registry entries.
 */
export const CONNECTOR_REGISTRY_FLAG = "CONNECTOR_REGISTRY_ENABLED";

export function connectorRegistryEnabled(): boolean {
  const raw = process.env[CONNECTOR_REGISTRY_FLAG]?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

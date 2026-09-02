/**
 * Transport-neutral connector-discovery capability metadata.
 *
 * These exist so an agent can author `flows/<slug>.yml`: a definition names
 * its connector by id and lists the entities to sync, and neither can be
 * invented. They are reads, they return no credential, and they are the
 * discovery half of RFC "agent-authored flows".
 *
 * `probe_connector` is the live half: it runs the connector against the
 * platform behind it (credential check + one bounded page of an entity) and
 * writes nothing. It is a read of external data, so like `sql_execute_query`
 * it is hidden from credentials without query access.
 *
 * Deliberately NOT the same thing as the dashboard `list_data_sources` /
 * `create_data_source` family, which operate on in-browser DuckDB
 * materializations. The similar naming has already misled one design
 * document into believing connector creation was a policy line away.
 */
import { ALL_AGENT_SURFACES, type AgentCapabilityDefinition } from "./types";

export type ConnectorCapabilityPack = "connector-discovery" | "connector-probe";

export type ConnectorCapabilityDefinition = AgentCapabilityDefinition<
  "connectors",
  ConnectorCapabilityPack
>;

const define = (
  definition: Omit<ConnectorCapabilityDefinition, "domain">,
): ConnectorCapabilityDefinition => ({ domain: "connectors", ...definition });

export const CONNECTOR_CAPABILITIES = [
  define({
    name: "list_connectors",
    pack: "connector-discovery",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "inspect_connector",
    pack: "connector-discovery",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "probe_connector",
    pack: "connector-probe",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
    requiresQueryAccess: true,
  }),
] as const satisfies readonly ConnectorCapabilityDefinition[];

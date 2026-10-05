/**
 * Transport-neutral connector-discovery capability metadata.
 *
 * These exist so an agent can author `flows/<slug>.yml`: a definition names
 * its connector by id and lists the entities to sync, and neither can be
 * invented. They are reads, they return no credential, and they are the
 * discovery half of RFC "agent-authored flows".
 *
 * Vocabulary: a CONNECTOR is code (`stripe`, `ws:vercel-ai-gateway`); a
 * CONNECTION is a credential configured with one, of kind `database` or
 * `source`. `list_connectors` / `inspect_connector` are the catalog of code;
 * `inspect_connection` describes one configured credential (of either kind);
 * `probe_connection` is the live half: it runs a source connection against
 * the platform behind it (credential check + one bounded page of an entity)
 * and writes nothing. It is a read of external data, so like
 * `sql_execute_query` it is hidden from credentials without query access.
 *
 * `create_source_connection` / `update_source_connection` are the write half,
 * and they are gated like membership is: the `sources-write` grant (scope
 * `sources:write`, never implicit) AND a live owner/admin role, re-checked
 * on every call. A credential is write-only — accepted, encrypted, never
 * returned — so these are external-MCP only: the in-product agent acts for a
 * signed-in user who has the "New source connection" form.
 *
 * Deliberately NOT the same thing as the dashboard `list_data_sources` /
 * `create_data_source` family, which operate on in-browser DuckDB
 * materializations. The similar naming has already misled one design
 * document into believing connector creation was a policy line away.
 */
import {
  ALL_AGENT_SURFACES,
  type AgentCapabilityDefinition,
  type AgentSurface,
} from "./types";

const EXTERNAL_MCP_ONLY = ["external-mcp"] as const satisfies readonly AgentSurface[];

export type ConnectorCapabilityPack =
  | "connector-discovery"
  | "connector-probe"
  | "connection-admin";

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
    name: "inspect_connection",
    pack: "connector-discovery",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  }),
  define({
    name: "probe_connection",
    pack: "connector-probe",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
    requiresQueryAccess: true,
  }),
  define({
    name: "create_source_connection",
    pack: "connection-admin",
    risk: "write",
    minimumWorkspaceRole: "admin",
    requiredGrant: "sources-write",
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "data",
  }),
  define({
    name: "update_source_connection",
    pack: "connection-admin",
    risk: "write",
    minimumWorkspaceRole: "admin",
    requiredGrant: "sources-write",
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "data",
  }),
] as const satisfies readonly ConnectorCapabilityDefinition[];

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
 * and writes nothing; `call_connection` sends one read request through a
 * source connection's proxy. Both read external data, so like
 * `sql_execute_query` it is hidden from credentials without query access.
 *
 * `create_connection` stores a new SOURCE connection (a credential) for a
 * connector, so an agent can go from "this connector exists" to probing it
 * without a human round-trip through the UI; `update_connection` renames one
 * or changes its plain settings, and `delete_connection` removes one. They
 * are external-MCP only. Every MCP/CLI credential holds the create grant
 * (`connections-write`); changing or deleting needs `connections-manage`,
 * which an API key carries only with the explicit `connections:manage`
 * scope (OAuth sign-ins carry it). The caller's live role must be at least
 * member, and changing or deleting takes being one of the connection's
 * managers, as in the UI. `set_connection_access` changes who may use a
 * connection (a database connection's writers; a source connection's
 * writers, live reads, live readers and managers). It needs its own grant,
 * `connections-access`, which no sign-in carries: only an API key created
 * with the `connections:access` scope. It acts for the people who may
 * change access in the app:
 * the workspace owner and admins for a database connection, a source
 * connection's managers and the workspace owner for theirs. They are kept
 * out of the in-product chat so a prompt-injected page cannot plant, repoint
 * or remove a credential the workspace syncs from, or widen who uses one.
 *
 * Deliberately NOT the same thing as the `list_data_sources` /
 * `inspect_data_source` family, which operate on in-browser DuckDB
 * materializations of app bindings. The similar naming has already misled one design
 * document into believing connector creation was a policy line away.
 */
import {
  ALL_AGENT_SURFACES,
  type AgentCapabilityDefinition,
  type AgentSurface,
} from "./types";

const EXTERNAL_MCP_ONLY = [
  "external-mcp",
] as const satisfies readonly AgentSurface[];

export type ConnectorCapabilityPack =
  "connector-discovery" | "connector-probe" | "connector-admin";

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
  // A live read through a source connection's proxy: the credential stays
  // in Mako and every write is refused there, whoever asks.
  define({
    name: "call_connection",
    pack: "connector-probe",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
    requiresQueryAccess: true,
  }),
  define({
    name: "create_connection",
    pack: "connector-admin",
    risk: "write",
    requiredGrant: "connections-write",
    // Anyone who can create a connection in the UI (any member) — never a
    // viewer, and re-checked against the live role on every call.
    minimumWorkspaceRole: "member",
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "data",
  }),
  // Renames, describes, disables, or changes plain config. Secrets and where
  // the key is sent stay in the app; access is set_connection_access.
  define({
    name: "update_connection",
    pack: "connector-admin",
    risk: "write",
    requiredGrant: "connections-manage",
    minimumWorkspaceRole: "member",
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "data",
  }),
  define({
    name: "delete_connection",
    pack: "connector-admin",
    risk: "destructive",
    requiredGrant: "connections-manage",
    minimumWorkspaceRole: "member",
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "data",
  }),
  // Who may use a connection, of either kind: writers, live reads, live
  // readers, managers. The tool checks the app's own rights live (owner or
  // admin for a database connection, a manager or the owner for a source).
  define({
    name: "set_connection_access",
    pack: "connector-admin",
    // It can take access away (a writer, a manager) as well as give it.
    risk: "destructive",
    requiredGrant: "connections-access",
    minimumWorkspaceRole: "member",
    surfaces: EXTERNAL_MCP_ONLY,
    resultKind: "data",
  }),
] as const satisfies readonly ConnectorCapabilityDefinition[];

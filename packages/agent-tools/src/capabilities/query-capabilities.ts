/**
 * Transport-neutral SQL / MongoDB discovery + execution capability metadata.
 *
 * Discovery and inspection are read-only everywhere. Raw execution, SQL and
 * MongoDB alike, carries the `query:read` scope envelope: a MongoDB query is
 * interpreted, never evaluated, and a read-only run refuses any write method,
 * command or $out/$merge stage (api mongo-shell-interpreter.ts).
 */
import {
  ALL_AGENT_SURFACES,
  IN_CHAT_ONLY_SURFACES,
  type AgentCapabilityDefinition,
} from "./types";

export type QueryCapabilityPack =
  "sql-discover" | "sql-execute" | "mongo-discover" | "mongo-execute";

export type QueryCapabilityDefinition = AgentCapabilityDefinition<
  "query",
  QueryCapabilityPack
>;

const define = (
  definition: Omit<QueryCapabilityDefinition, "domain">,
): QueryCapabilityDefinition => ({ domain: "query", ...definition });

const sqlDiscover = (name: string): QueryCapabilityDefinition =>
  define({
    name,
    pack: "sql-discover",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  });

/**
 * A deprecated per-engine alias of the cross-engine discovery family. It
 * stays registered for chats that already called it, and leaves the MCP
 * surfaces: no in-repo client calls it, and every MCP client gets the
 * cross-engine tool it stands for.
 */
const deprecatedDiscoverAlias = (
  name: string,
  pack: "sql-discover" | "mongo-discover",
  replacement: string,
): QueryCapabilityDefinition =>
  define({
    name,
    pack,
    risk: "read",
    surfaces: IN_CHAT_ONLY_SURFACES,
    resultKind: "data",
    mcpExclusion: {
      why: "deferred",
      note: `Deprecated alias; MCP exposes ${replacement}.`,
    },
  });

export const QUERY_CAPABILITIES = [
  // ── Cross-engine discovery (dispatches on connection type) ──────────────
  sqlDiscover("list_connections"),
  sqlDiscover("list_databases"),
  sqlDiscover("list_tables"),
  sqlDiscover("inspect_table"),
  // ── SQL (deprecated aliases of the cross-engine family) ─────────────────
  deprecatedDiscoverAlias(
    "sql_list_connections",
    "sql-discover",
    "list_connections",
  ),
  deprecatedDiscoverAlias(
    "sql_list_databases",
    "sql-discover",
    "list_databases",
  ),
  deprecatedDiscoverAlias("sql_list_tables", "sql-discover", "list_tables"),
  deprecatedDiscoverAlias("sql_inspect_table", "sql-discover", "inspect_table"),
  define({
    name: "sql_execute_query",
    pack: "sql-execute",
    risk: "write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
    requiresQueryAccess: true,
  }),
  // ── MongoDB (discovery entries are deprecated aliases) ──────────────────
  deprecatedDiscoverAlias(
    "mongo_list_connections",
    "mongo-discover",
    "list_connections",
  ),
  deprecatedDiscoverAlias(
    "mongo_list_databases",
    "mongo-discover",
    "list_databases",
  ),
  deprecatedDiscoverAlias(
    "mongo_list_collections",
    "mongo-discover",
    "list_tables",
  ),
  deprecatedDiscoverAlias(
    "mongo_inspect_collection",
    "mongo-discover",
    "inspect_table",
  ),
  define({
    name: "mongo_execute_query",
    pack: "mongo-execute",
    risk: "write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
    requiresQueryAccess: true,
  }),
] as const satisfies readonly QueryCapabilityDefinition[];

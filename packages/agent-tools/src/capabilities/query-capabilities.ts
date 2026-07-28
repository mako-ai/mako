/**
 * Transport-neutral SQL / MongoDB discovery + execution capability metadata.
 *
 * Discovery and inspection are read-only everywhere. Raw execution carries
 * the `query:read` scope envelope; MongoDB execution stays in-product because
 * arbitrary Mongo JavaScript has no reliable per-query read-only mode.
 */
import {
  ALL_AGENT_SURFACES,
  IN_CHAT_ONLY_SURFACES,
  type AgentCapabilityDefinition,
} from "./types";

export type QueryCapabilityPack =
  | "sql-discover"
  | "sql-execute"
  | "mongo-discover"
  | "mongo-execute";

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

const mongoDiscover = (name: string): QueryCapabilityDefinition =>
  define({
    name,
    pack: "mongo-discover",
    risk: "read",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
  });

export const QUERY_CAPABILITIES = [
  // ── Cross-engine discovery ──────────────────────────────────────────────
  sqlDiscover("list_connections"),
  // ── SQL ─────────────────────────────────────────────────────────────────
  sqlDiscover("sql_list_connections"),
  sqlDiscover("sql_list_databases"),
  sqlDiscover("sql_list_tables"),
  sqlDiscover("sql_inspect_table"),
  define({
    name: "sql_execute_query",
    pack: "sql-execute",
    risk: "write",
    surfaces: ALL_AGENT_SURFACES,
    resultKind: "data",
    requiresQueryAccess: true,
  }),
  // ── MongoDB ─────────────────────────────────────────────────────────────
  mongoDiscover("mongo_list_connections"),
  mongoDiscover("mongo_list_databases"),
  mongoDiscover("mongo_list_collections"),
  mongoDiscover("mongo_inspect_collection"),
  define({
    name: "mongo_execute_query",
    pack: "mongo-execute",
    risk: "write",
    surfaces: IN_CHAT_ONLY_SURFACES,
    resultKind: "data",
    mcpExclusion: {
      why: "security",
      note: "Arbitrary MongoDB JavaScript has no reliable per-query read-only mode.",
    },
  }),
] as const satisfies readonly QueryCapabilityDefinition[];

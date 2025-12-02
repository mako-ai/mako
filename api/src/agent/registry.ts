import { AgentConfig, AgentRegistration, DatabaseAgentKind } from "./types";
import { buildMongoAgent } from "./mongodb/agent";
import { createMongoTools } from "./mongodb/tools";
import { buildBigQueryAgent } from "./bigquery/agent";
import { createBigQueryTools } from "./bigquery/tools";
import { buildPostgresAgent } from "./postgres/agent";
import { createPostgresTools } from "./postgres/tools";
import { buildSqliteAgent } from "./sqlite/agent";
import { createSqliteTools } from "./sqlite/tools";
import { buildCloudflareKVAgent } from "./cloudflare-kv/agent";
import { createCloudflareKVTools } from "./cloudflare-kv/tools";

type RegistrationMap = Map<DatabaseAgentKind, AgentRegistration>;

const agentRegistry: RegistrationMap = new Map();

const coreRegistrations: AgentRegistration[] = [
  {
    kind: "mongo",
    buildAgent: (config: AgentConfig) =>
      buildMongoAgent(
        config.workspaceId,
        config.consoles,
        config.preferredConsoleId,
      ),
    createTools: (config: AgentConfig) =>
      createMongoTools(
        config.workspaceId,
        config.consoles,
        config.preferredConsoleId,
      ),
    metadata: {
      name: "MongoDB Assistant",
      handoffDescription:
        "Specialist for MongoDB databases. Use when the task involves MongoDB collections or queries.",
      kind: "mongo",
    },
    handoff: {
      toolName: "transfer_to_mongodb",
      description:
        "Transfer the conversation to the MongoDB Assistant for MongoDB-related tasks.",
    },
    discoveryToolNames: [
      "list_databases",
      "mongo_list_databases",
      "list_collections",
      "inspect_collection",
    ],
  },
  {
    kind: "bigquery",
    buildAgent: (config: AgentConfig) =>
      buildBigQueryAgent(
        config.workspaceId,
        config.consoles,
        config.preferredConsoleId,
      ),
    createTools: (config: AgentConfig) =>
      createBigQueryTools(
        config.workspaceId,
        config.consoles,
        config.preferredConsoleId,
      ),
    metadata: {
      name: "BigQuery Assistant",
      handoffDescription:
        "Specialist for BigQuery datasets and SQL. Use when the task targets analytics tables in BigQuery.",
      kind: "bigquery",
    },
    handoff: {
      toolName: "transfer_to_bigquery",
      description:
        "Transfer the conversation to the BigQuery Assistant for BigQuery-related tasks.",
    },
    discoveryToolNames: [
      "bq_list_databases",
      "list_databases",
      "bq_list_datasets",
      "list_datasets",
      "bq_list_tables",
      "list_tables",
      "bq_inspect_table",
      "inspect_table",
    ],
  },
  {
    kind: "postgres",
    buildAgent: (config: AgentConfig) =>
      buildPostgresAgent(
        config.workspaceId,
        config.consoles,
        config.preferredConsoleId,
      ),
    createTools: (config: AgentConfig) =>
      createPostgresTools(
        config.workspaceId,
        config.consoles,
        config.preferredConsoleId,
      ),
    metadata: {
      name: "Postgres Assistant",
      handoffDescription:
        "Specialist for PostgreSQL databases and SQL. Use when the task targets relational data in Postgres.",
      kind: "postgres",
    },
    handoff: {
      toolName: "transfer_to_postgres",
      description:
        "Transfer the conversation to the Postgres Assistant for PostgreSQL-related tasks.",
    },
    discoveryToolNames: [
      "pg_list_databases",
      "list_databases",
      "pg_list_schemas",
      "list_schemas",
      "pg_list_tables",
      "list_tables",
      "pg_describe_table",
      "describe_table",
    ],
  },
  {
    kind: "sqlite",
    buildAgent: (config: AgentConfig) =>
      buildSqliteAgent(
        config.workspaceId,
        config.consoles,
        config.preferredConsoleId,
      ),
    createTools: (config: AgentConfig) =>
      createSqliteTools(
        config.workspaceId,
        config.consoles,
        config.preferredConsoleId,
      ),
    metadata: {
      name: "SQLite Assistant",
      handoffDescription:
        "Specialist for SQLite and Cloudflare D1 databases. Use when the task targets SQLite data or D1 databases.",
      kind: "sqlite",
    },
    handoff: {
      toolName: "transfer_to_sqlite",
      description:
        "Transfer the conversation to the SQLite Assistant for SQLite/Cloudflare D1 database-related tasks.",
    },
    discoveryToolNames: [
      "sqlite_list_databases",
      "list_databases",
      "sqlite_list_tables",
      "list_tables",
      "sqlite_describe_table",
      "describe_table",
    ],
  },
  {
    kind: "cloudflare-kv",
    buildAgent: (config: AgentConfig) =>
      buildCloudflareKVAgent(
        config.workspaceId,
        config.consoles,
        config.preferredConsoleId,
      ),
    createTools: (config: AgentConfig) =>
      createCloudflareKVTools(
        config.workspaceId,
        config.consoles,
        config.preferredConsoleId,
      ),
    metadata: {
      name: "Cloudflare KV Assistant",
      handoffDescription:
        "Specialist for Cloudflare Workers KV Store. Use when the task targets key-value data in Cloudflare KV namespaces.",
      kind: "cloudflare-kv",
    },
    handoff: {
      toolName: "transfer_to_cloudflare_kv",
      description:
        "Transfer the conversation to the Cloudflare KV Assistant for KV Store-related tasks.",
    },
    discoveryToolNames: [
      "kv_list_connections",
      "list_connections",
      "kv_list_namespaces",
      "list_namespaces",
      "kv_list_keys",
      "list_keys",
    ],
  },
];

for (const registration of coreRegistrations) {
  agentRegistry.set(registration.kind, registration);
}

export const getAgentRegistration = (
  kind: DatabaseAgentKind,
): AgentRegistration | undefined => agentRegistry.get(kind);

export const listAgentRegistrations = (): AgentRegistration[] =>
  Array.from(agentRegistry.values());

export const registerAgent = (registration: AgentRegistration): void => {
  if (agentRegistry.has(registration.kind)) {
    throw new Error(`Agent kind "${registration.kind}" is already registered.`);
  }
  agentRegistry.set(registration.kind, registration);
};

export const getRegisteredAgentKinds = (): DatabaseAgentKind[] =>
  Array.from(agentRegistry.keys());

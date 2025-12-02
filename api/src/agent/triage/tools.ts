// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – provided at runtime
import { Tool, tool } from "@openai/agents";
import { Types } from "mongoose";
import { DatabaseConnection } from "../../database/workspace-schema";
import { AgentConfig, AgentRegistration } from "../types";
import { listAgentRegistrations } from "../registry";
import { createConsoleTools } from "../shared/console-tools";

const getToolName = (tool: Tool): string | undefined =>
  (tool as any)?.schema?.name || (tool as any)?.name;

const buildConfig = (
  workspaceId: string,
  consoles?: any[],
  preferredConsoleId?: string,
): AgentConfig => ({
  workspaceId,
  consoles,
  preferredConsoleId,
});

// List ALL databases without filtering by type - critical for triage to see everything
const listAllDatabases = async (workspaceId: string) => {
  if (!Types.ObjectId.isValid(workspaceId)) {
    throw new Error("Invalid workspace ID");
  }

  const databases = await DatabaseConnection.find({
    workspaceId: new Types.ObjectId(workspaceId),
  }).sort({ name: 1 });

  return databases.map(db => {
    const connection: any = (db as any).connection || {};
    let displayInfo = "";

    // Format display info based on database type
    if (db.type === "mongodb") {
      displayInfo = connection.database || "Unknown Database";
    } else if (db.type === "bigquery") {
      displayInfo = connection.project_id || "Unknown Project";
    } else if (db.type === "postgresql" || db.type === "cloudsql-postgres") {
      const host =
        connection.host || connection.instanceConnectionName || "unknown-host";
      const database =
        connection.database || connection.db || "unknown-database";
      displayInfo = `${host}/${database}`;
    } else if (db.type === "cloudflare-kv") {
      const accountId = connection.account_id || "unknown-account";
      const namespaceId = connection.namespace_id;
      displayInfo = namespaceId
        ? `${accountId}/${namespaceId}`
        : `${accountId} (all namespaces)`;
    } else if (db.type === "cloudflare-d1") {
      const accountId = connection.account_id || "unknown-account";
      const databaseId = connection.database_id;
      displayInfo = databaseId
        ? `${accountId}/${databaseId}`
        : `${accountId} (all databases)`;
    } else {
      displayInfo = connection.database || connection.db || "Unknown";
    }

    return {
      id: db._id.toString(),
      name: db.name,
      type: db.type,
      displayName: `${db.name} (${db.type}: ${displayInfo})`,
      connection: connection,
      active: true,
    };
  });
};

const gatherDiscoveryTools = (
  registration: AgentRegistration,
  config: AgentConfig,
): Tool[] => {
  if (!registration.createTools || !registration.discoveryToolNames?.length) {
    return [];
  }

  const allowedNames = new Set(registration.discoveryToolNames);
  const tools = registration.createTools(config);

  return tools.filter(tool => {
    const name = getToolName(tool);
    return name ? allowedNames.has(name) : false;
  });
};

export const createTriageTools = (
  workspaceId: string,
  consoles?: any[],
  preferredConsoleId?: string,
): Tool[] => {
  const config = buildConfig(workspaceId, consoles, preferredConsoleId);

  const toolsByName = new Map<string, Tool>();

  // Add comprehensive list_databases tool FIRST - this overrides agent-specific filtered versions
  const listDatabasesTool = tool({
    name: "list_databases",
    description:
      "List ALL databases in the workspace (MongoDB, PostgreSQL, BigQuery, etc.) without filtering by type",
    parameters: {
      type: "object",
      properties: {},
      required: [],
      additionalProperties: false,
    },
    execute: async () => listAllDatabases(workspaceId),
  });
  toolsByName.set("list_databases", listDatabasesTool);

  // Add console tools - critical for triage to understand context
  const consoleTools = createConsoleTools(consoles, preferredConsoleId);
  for (const tool of consoleTools) {
    const name = getToolName(tool);
    if (name && (name === "read_console" || name === "list_consoles")) {
      // Only add read_console and list_consoles for triage, not modify/create
      toolsByName.set(name, tool);
    }
  }

  // Then add discovery tools from registered agents (except list_databases which we override)
  for (const registration of listAgentRegistrations()) {
    const discoveryTools = gatherDiscoveryTools(registration, config);
    for (const tool of discoveryTools) {
      const name = getToolName(tool);
      // Skip list_databases from agents since we have our comprehensive version
      if (name && name !== "list_databases" && !toolsByName.has(name)) {
        toolsByName.set(name, tool);
      }
    }
  }

  return Array.from(toolsByName.values());
};

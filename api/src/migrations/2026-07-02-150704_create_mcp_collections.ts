import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Create MCP collections (mcp_servers, mcp_connection_configs, mcp_tool_grants) with indexes";

function hasIndexOnKeys(
  indexes: { key: Record<string, number | string> }[],
  keyPattern: Record<string, number | string>,
): boolean {
  const target = JSON.stringify(keyPattern);
  return indexes.some(idx => JSON.stringify(idx.key) === target);
}

async function ensureCollection(db: Db, name: string): Promise<void> {
  const existing = await db.listCollections({ name }).toArray();
  if (existing.length === 0) {
    await db.createCollection(name);
    log.info(`Created '${name}' collection`);
  } else {
    log.info(`'${name}' collection already exists`);
  }
}

export async function up(db: Db): Promise<void> {
  await ensureCollection(db, "mcp_servers");
  await ensureCollection(db, "mcp_connection_configs");
  await ensureCollection(db, "mcp_tool_grants");

  const servers = db.collection("mcp_servers");
  let indexes = await servers.indexes();
  if (!hasIndexOnKeys(indexes, { workspaceId: 1, name: 1 })) {
    await servers.createIndex(
      { workspaceId: 1, name: 1 },
      { unique: true, name: "mcp_servers_workspace_name_unique" },
    );
    log.info("Created unique index on mcp_servers { workspaceId, name }");
  }
  if (!hasIndexOnKeys(indexes, { workspaceId: 1, isActive: 1 })) {
    await servers.createIndex(
      { workspaceId: 1, isActive: 1 },
      { name: "mcp_servers_workspace_active" },
    );
    log.info("Created index on mcp_servers { workspaceId, isActive }");
  }

  const configs = db.collection("mcp_connection_configs");
  indexes = await configs.indexes();
  if (!hasIndexOnKeys(indexes, { serverId: 1, userId: 1 })) {
    await configs.createIndex(
      { serverId: 1, userId: 1 },
      { unique: true, name: "mcp_connection_configs_server_user_unique" },
    );
    log.info(
      "Created unique index on mcp_connection_configs { serverId, userId }",
    );
  }
  if (!hasIndexOnKeys(indexes, { workspaceId: 1 })) {
    await configs.createIndex(
      { workspaceId: 1 },
      { name: "mcp_connection_configs_workspace" },
    );
    log.info("Created index on mcp_connection_configs { workspaceId }");
  }

  const grants = db.collection("mcp_tool_grants");
  indexes = await grants.indexes();
  if (!hasIndexOnKeys(indexes, { serverId: 1, userId: 1, toolName: 1 })) {
    await grants.createIndex(
      { serverId: 1, userId: 1, toolName: 1 },
      { unique: true, name: "mcp_tool_grants_server_user_tool_unique" },
    );
    log.info(
      "Created unique index on mcp_tool_grants { serverId, userId, toolName }",
    );
  }
  if (!hasIndexOnKeys(indexes, { workspaceId: 1, userId: 1 })) {
    await grants.createIndex(
      { workspaceId: 1, userId: 1 },
      { name: "mcp_tool_grants_workspace_user" },
    );
    log.info("Created index on mcp_tool_grants { workspaceId, userId }");
  }
}

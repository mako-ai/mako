/**
 * MCP domain repository entry point (Neon Postgres `pg_only`).
 */
import { createPgFirstRepoProxy } from "../resolve-repo";
import { MongoMcpRepository } from "./mongo.repo";
import { PgMcpRepository } from "./pg.repo";
import type { McpRepository } from "./types";

export * from "./types";
export * from "./mapper";
export { MongoMcpRepository } from "./mongo.repo";
export { PgMcpRepository } from "./pg.repo";

const defaultMcpRepo: McpRepository = createPgFirstRepoProxy<McpRepository>(
  "mcp",
  new PgMcpRepository(),
  new MongoMcpRepository(),
);
let activeMcpRepo: McpRepository = defaultMcpRepo;

export function getMcpRepo(): McpRepository {
  return activeMcpRepo;
}

export function setMcpRepoForTests(repo: McpRepository): void {
  activeMcpRepo = repo;
}

export function resetMcpRepoForTests(): void {
  activeMcpRepo = defaultMcpRepo;
}

export const mcpRepo: McpRepository = {
  listServersByWorkspace: workspaceId =>
    activeMcpRepo.listServersByWorkspace(workspaceId),
  listActiveConnectedServers: workspaceId =>
    activeMcpRepo.listActiveConnectedServers(workspaceId),
  findServerById: (serverId, workspaceId) =>
    activeMcpRepo.findServerById(serverId, workspaceId),
  createServer: input => activeMcpRepo.createServer(input),
  updateServer: (workspaceId, serverId, patch) =>
    activeMcpRepo.updateServer(workspaceId, serverId, patch),
  deleteServerCascade: (workspaceId, serverId) =>
    activeMcpRepo.deleteServerCascade(workspaceId, serverId),

  listConnectionConfigsByServerIds: (workspaceId, serverIds) =>
    activeMcpRepo.listConnectionConfigsByServerIds(workspaceId, serverIds),
  listConnectionConfigsForUser: (workspaceId, serverIds, userId) =>
    activeMcpRepo.listConnectionConfigsForUser(workspaceId, serverIds, userId),
  findConnectionConfig: (workspaceId, serverId, userId) =>
    activeMcpRepo.findConnectionConfig(workspaceId, serverId, userId),
  upsertConnectionCredentials: input =>
    activeMcpRepo.upsertConnectionCredentials(input),
  upsertConnectionOAuthTokens: input =>
    activeMcpRepo.upsertConnectionOAuthTokens(input),
  clearServerOAuthTokens: (workspaceId, serverId) =>
    activeMcpRepo.clearServerOAuthTokens(workspaceId, serverId),

  upsertOAuthFlow: input => activeMcpRepo.upsertOAuthFlow(input),
  findOAuthFlowByState: (state, now) =>
    activeMcpRepo.findOAuthFlowByState(state, now),
  findOAuthFlowById: (flowId, workspaceId, now) =>
    activeMcpRepo.findOAuthFlowById(flowId, workspaceId, now),
  deleteOAuthFlowById: (flowId, workspaceId) =>
    activeMcpRepo.deleteOAuthFlowById(flowId, workspaceId),
  isSameUser: (userIdA, userIdB) => activeMcpRepo.isSameUser(userIdA, userIdB),

  listToolGrantsForUser: (workspaceId, serverId, userId) =>
    activeMcpRepo.listToolGrantsForUser(workspaceId, serverId, userId),
  findToolGrantsForResolution: params =>
    activeMcpRepo.findToolGrantsForResolution(params),
  upsertToolGrant: input => activeMcpRepo.upsertToolGrant(input),
  touchToolGrantLastUsed: params =>
    activeMcpRepo.touchToolGrantLastUsed(params),
  deleteToolGrantById: (workspaceId, serverId, grantId, userId) =>
    activeMcpRepo.deleteToolGrantById(workspaceId, serverId, grantId, userId),
};

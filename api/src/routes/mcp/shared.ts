/** Params, the admin check and the server loader/serializer shared by the MCP server routers. */
import { z } from "@hono/zod-openapi";
import { workspaceService } from "../../services/workspace.service";
import { AuthenticatedContext } from "../../middleware/workspace.middleware";
import { parseEntityId } from "../../database/pg/id-codec";
import { mcpRepo, type McpServerRecord } from "../../repositories/mcp";
import { getMcpPreset, mcpPresetEnvOAuthClient } from "../../mcp/presets";
import { decryptString } from "../../services/crypto.service";
import {
  mcpToolRestriction,
  mcpToolRiskTier,
} from "../../services/mcp-client.service";
import { mcpOAuthClientSource } from "../../services/mcp-oauth.service";

export const WorkspaceParam = z.object({
  workspaceId: z
    .string()
    .openapi({ param: { name: "workspaceId", in: "path" } }),
});
export const ServerIdParam = WorkspaceParam.extend({
  id: z.string().openapi({ param: { name: "id", in: "path" } }),
});

export async function requireAdmin(
  c: AuthenticatedContext,
  workspaceId: string,
): Promise<string | null> {
  const user = c.get("user");
  if (!user) return null;
  const isAdmin = await workspaceService.isAdmin(workspaceId, user.id);
  return isAdmin ? user.id : null;
}

/** Non-secret client id of the server's OAuth app (workspace or env). */
function oauthClientIdOf(server: McpServerRecord): string | null {
  const encrypted = server.oauthClientInformationEncrypted;
  if (encrypted) {
    try {
      const info = JSON.parse(decryptString(encrypted)) as {
        client_id?: string;
      };
      if (info.client_id) return info.client_id;
    } catch {
      // Fall through to the env client.
    }
  }
  return (
    mcpPresetEnvOAuthClient(getMcpPreset(server.connectorType))?.client_id ??
    null
  );
}

export function serializeServer(
  server: McpServerRecord,
  extras: {
    hasWorkspaceCredential?: boolean;
    hasUserCredential?: boolean;
  } = {},
) {
  return {
    id: server.id,
    name: server.name,
    description: server.description ?? null,
    connectorType: server.connectorType,
    transport: server.transport,
    authType: server.authType,
    authPerformer: server.authPerformer,
    writeScope: server.writeScope,
    toolPolicy: {
      defaultRestriction: server.toolPolicy?.defaultRestriction ?? "always",
      restrictions: server.toolPolicy?.restrictions ?? {},
    },
    cachedTools: (server.cachedTools ?? []).map(t => ({
      name: t.name,
      description: t.description ?? null,
      annotations: t.annotations ?? null,
      riskTier: mcpToolRiskTier(server, t),
      restriction: mcpToolRestriction(server, t),
    })),
    status: server.status,
    lastError: server.lastError ?? null,
    lastConnectedAt: server.lastConnectedAt ?? null,
    isActive: server.isActive,
    createdBy: server.createdBy,
    createdAt: server.createdAt,
    updatedAt: server.updatedAt,
    hasWorkspaceCredential: extras.hasWorkspaceCredential ?? false,
    hasUserCredential: extras.hasUserCredential ?? false,
    // Manual-client OAuth presets (Slack): whether a provider app is usable
    // (workspace-saved or a deployment-wide env client), where it comes
    // from, and its (non-secret) client id.
    hasOAuthClient: mcpOAuthClientSource(server) !== null,
    oauthClientSource: mcpOAuthClientSource(server),
    oauthClientId: oauthClientIdOf(server),
  };
}

export async function loadServer(
  workspaceId: string,
  id: string,
): Promise<McpServerRecord | null> {
  if (!parseEntityId(id) || !parseEntityId(workspaceId)) return null;
  return mcpRepo.findServerById(id, workspaceId);
}

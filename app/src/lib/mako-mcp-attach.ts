/**
 * Mint a short-lived MCP Bearer so Local Agent can attach Mako `/api/mcp`
 * on ACP session/new (workspace DB tools for Claude Code / Codex).
 */
import { api, unwrapBody } from "../api";

export interface MakoMcpAttachCredentials {
  mcpUrl: string;
  mcpAuthorization: string;
  expiresIn: number;
}

export async function mintMakoMcpAttach(
  workspaceId: string,
): Promise<MakoMcpAttachCredentials> {
  const response = unwrapBody(
    await api.POST("/api/workspaces/{id}/mcp-access-token", {
      params: { path: { id: workspaceId } },
    }),
  ) as {
    success?: boolean;
    data?: {
      accessToken?: string;
      authorization?: string;
      expiresIn?: number;
      mcpPath?: string;
    };
    error?: string;
  };

  const data = response?.data;
  const authorization =
    data?.authorization ||
    (data?.accessToken ? `Bearer ${data.accessToken}` : "");
  if (!authorization) {
    throw new Error(response?.error || "Failed to mint Mako MCP access token");
  }

  const origin = window.location.origin.replace(/\/$/, "");
  const path = data?.mcpPath?.startsWith("/") ? data.mcpPath : "/api/mcp";

  return {
    mcpUrl: `${origin}${path}`,
    mcpAuthorization: authorization,
    expiresIn: data?.expiresIn ?? 0,
  };
}

export function getActiveWorkspaceId(): string | null {
  try {
    return localStorage.getItem("activeWorkspaceId");
  } catch {
    return null;
  }
}

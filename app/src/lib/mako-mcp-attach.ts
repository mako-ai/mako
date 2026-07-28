/**
 * Mint a short-lived MCP Bearer so Local Agent can attach Mako `/api/mcp`
 * on ACP session/new (workspace DB tools for Claude Code / Codex).
 *
 * Server name is `mako-workspace` (not `mako`) so it does not collide with
 * Claude.ai's optional "Mako" connector that requires a separate OAuth dance.
 */
import { api, unwrapBody } from "../api";

/** ACP / Claude Agent SDK MCP server name for the attached workspace tools. */
export const MAKO_WORKSPACE_MCP_NAME = "mako-workspace";

export interface MakoMcpAttachCredentials {
  mcpUrl: string;
  mcpAuthorization: string;
  expiresIn: number;
  mcpServerName: string;
  agentSessionId: string;
}

/** Absolute MCP URL that the Local Agent (on the user's machine) can reach. */
export function resolveAbsoluteMcpUrl(): string {
  const env = (import.meta.env.VITE_API_URL || "").trim();
  if (/^https?:\/\//i.test(env)) {
    const base = env.replace(/\/$/, "");
    if (base.endsWith("/api")) return `${base}/mcp`;
    if (base.endsWith("/api/mcp")) return base;
    return `${base}/api/mcp`;
  }
  return `${window.location.origin.replace(/\/$/, "")}/api/mcp`;
}

export async function mintMakoMcpAttach(
  workspaceId: string,
): Promise<MakoMcpAttachCredentials> {
  if (!workspaceId.trim()) {
    throw new Error("Workspace is required to attach Mako data tools");
  }

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
      agentSessionId?: string;
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
  if (!data?.agentSessionId) {
    throw new Error("Mako MCP access token is missing its agent session");
  }

  return {
    mcpUrl: resolveAbsoluteMcpUrl(),
    mcpAuthorization: authorization,
    expiresIn: data?.expiresIn ?? 0,
    mcpServerName: MAKO_WORKSPACE_MCP_NAME,
    agentSessionId: data.agentSessionId,
  };
}

export function getActiveWorkspaceId(): string | null {
  try {
    return localStorage.getItem("activeWorkspaceId");
  } catch {
    return null;
  }
}

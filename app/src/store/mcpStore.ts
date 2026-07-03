/**
 * MCP servers store — Settings → MCP Servers management plus the tool
 * metadata the chat approval cards need (risk tier, grantability).
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api, unwrapBody } from "../api";

export type McpWriteScope = "read" | "write_safe" | "write_destructive";
export type McpRiskTier = "read" | "write" | "destructive";
export type McpServerStatus =
  | "created"
  | "awaiting_auth"
  | "connected"
  | "error";

export type McpToolRestriction = "always" | "ask" | "block";

export interface McpCachedTool {
  name: string;
  description: string | null;
  riskTier: McpRiskTier;
  /** Effective admin ceiling for this tool (explicit or default). */
  restriction: McpToolRestriction;
}

export interface McpServerInfo {
  id: string;
  name: string;
  description: string | null;
  connectorType: string;
  transport: { type: string; url: string };
  authType: "none" | "api_key" | "oauth";
  authPerformer: "workspace" | "user";
  writeScope: McpWriteScope;
  toolPolicy: {
    defaultRestriction: McpToolRestriction;
    restrictions: Record<string, McpToolRestriction>;
  };
  cachedTools: McpCachedTool[];
  status: McpServerStatus;
  lastError: string | null;
  lastConnectedAt: string | null;
  isActive: boolean;
  hasWorkspaceCredential: boolean;
  hasUserCredential: boolean;
}

export interface McpPresetHeaderField {
  name: string;
  label: string;
  type: "password" | "string";
  required: boolean;
  helperText?: string;
}

export interface McpPresetInfo {
  type: string;
  label: string;
  description: string;
  icon?: string;
  url: string;
  urlEditable: boolean;
  authType: "none" | "api_key" | "oauth";
  authOptions: Array<"none" | "api_key" | "oauth">;
  headerFields: McpPresetHeaderField[];
}

export interface McpToolUiInfo {
  prefixedName: string;
  serverId: string;
  serverName: string;
  serverIcon: string | null;
  toolName: string;
  riskTier: McpRiskTier;
  canAlwaysAllow: boolean;
}

export interface McpGrant {
  id: string;
  toolName: string;
  decision: "always_allow" | "always_deny";
  lastUsedAt: string | null;
  createdAt: string;
}

interface McpState {
  servers: McpServerInfo[];
  presets: McpPresetInfo[];
  /** prefixed tool name → UI info, for chat approval cards. */
  toolInfo: Record<string, McpToolUiInfo>;
  grants: Record<string, McpGrant[]>; // serverId → my grants
  loading: boolean;
  error: string | null;
}

interface McpActions {
  fetchServers: (workspaceId: string) => Promise<void>;
  fetchPresets: () => Promise<void>;
  fetchToolInfo: (workspaceId: string) => Promise<void>;
  fetchGrants: (workspaceId: string, serverId: string) => Promise<void>;
  createServer: (
    workspaceId: string,
    body: {
      name: string;
      connectorType: string;
      url?: string;
      description?: string;
      authType?: "none" | "api_key" | "oauth";
      writeScope?: McpWriteScope;
    },
  ) => Promise<McpServerInfo>;
  /** Start the OAuth flow; resolves with the URL to send the browser to. */
  startOAuth: (
    workspaceId: string,
    serverId: string,
  ) => Promise<{ authorizationUrl: string; alreadyAuthorized: boolean }>;
  updateServer: (
    workspaceId: string,
    serverId: string,
    body: Record<string, unknown>,
  ) => Promise<void>;
  deleteServer: (workspaceId: string, serverId: string) => Promise<void>;
  saveCredentials: (
    workspaceId: string,
    serverId: string,
    headers: Record<string, string>,
  ) => Promise<void>;
  testServer: (
    workspaceId: string,
    serverId: string,
  ) => Promise<{ ok: boolean; error?: string }>;
  saveGrant: (
    workspaceId: string,
    serverId: string,
    toolName: string,
    decision: "always_allow" | "always_deny",
  ) => Promise<void>;
  revokeGrant: (
    workspaceId: string,
    serverId: string,
    grantId: string,
  ) => Promise<void>;
}

type McpStore = McpState & McpActions;

export const useMcpStore = create<McpStore>()(
  immer((set, get) => ({
    servers: [],
    presets: [],
    toolInfo: {},
    grants: {},
    loading: false,
    error: null,

    fetchServers: async workspaceId => {
      set(state => {
        state.loading = true;
        state.error = null;
      });
      try {
        const response = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/mcp-servers", {
            params: { path: { workspaceId } },
          }),
        ) as { servers: McpServerInfo[] };
        set(state => {
          state.servers = response.servers ?? [];
          state.loading = false;
        });
      } catch (error) {
        set(state => {
          state.loading = false;
          state.error =
            error instanceof Error ? error.message : "Failed to load servers";
        });
      }
    },

    fetchPresets: async () => {
      if (get().presets.length > 0) return;
      try {
        const response = unwrapBody(await api.GET("/api/mcp/presets", {})) as {
          presets: McpPresetInfo[];
        };
        set(state => {
          state.presets = response.presets ?? [];
        });
      } catch {
        // Presets are static metadata; the form falls back to custom-only.
      }
    },

    fetchToolInfo: async workspaceId => {
      try {
        const response = unwrapBody(
          await api.GET("/api/workspaces/{workspaceId}/mcp-servers/tool-info", {
            params: { path: { workspaceId } },
          }),
        ) as { tools: McpToolUiInfo[] };
        set(state => {
          state.toolInfo = Object.fromEntries(
            (response.tools ?? []).map(t => [t.prefixedName, t]),
          );
        });
      } catch {
        // Non-fatal: approval cards fall back to generic labels.
      }
    },

    fetchGrants: async (workspaceId, serverId) => {
      try {
        const response = unwrapBody(
          await api.GET(
            "/api/workspaces/{workspaceId}/mcp-servers/{id}/grants",
            { params: { path: { workspaceId, id: serverId } } },
          ),
        ) as { grants: McpGrant[] };
        set(state => {
          state.grants[serverId] = response.grants ?? [];
        });
      } catch {
        // Non-fatal.
      }
    },

    createServer: async (workspaceId, body) => {
      const response = unwrapBody(
        await api.POST("/api/workspaces/{workspaceId}/mcp-servers", {
          params: { path: { workspaceId } },
          body,
        }),
      ) as { server: McpServerInfo };
      await get().fetchServers(workspaceId);
      return response.server;
    },

    startOAuth: async (workspaceId, serverId) => {
      const response = unwrapBody(
        await api.POST(
          "/api/workspaces/{workspaceId}/mcp-servers/{id}/oauth/connect",
          { params: { path: { workspaceId, id: serverId } } },
        ),
      ) as { authorizationUrl: string; alreadyAuthorized: boolean };
      return response;
    },

    updateServer: async (workspaceId, serverId, body) => {
      unwrapBody(
        await api.PATCH("/api/workspaces/{workspaceId}/mcp-servers/{id}", {
          params: { path: { workspaceId, id: serverId } },
          body,
        }),
      );
      await get().fetchServers(workspaceId);
    },

    deleteServer: async (workspaceId, serverId) => {
      unwrapBody(
        await api.DELETE("/api/workspaces/{workspaceId}/mcp-servers/{id}", {
          params: { path: { workspaceId, id: serverId } },
        }),
      );
      await get().fetchServers(workspaceId);
    },

    saveCredentials: async (workspaceId, serverId, headers) => {
      unwrapBody(
        await api.PUT(
          "/api/workspaces/{workspaceId}/mcp-servers/{id}/credentials",
          {
            params: { path: { workspaceId, id: serverId } },
            body: { headers },
          },
        ),
      );
      await get().fetchServers(workspaceId);
    },

    testServer: async (workspaceId, serverId) => {
      try {
        unwrapBody(
          await api.POST(
            "/api/workspaces/{workspaceId}/mcp-servers/{id}/test",
            { params: { path: { workspaceId, id: serverId } } },
          ),
        );
        await get().fetchServers(workspaceId);
        return { ok: true };
      } catch (error) {
        await get().fetchServers(workspaceId);
        return {
          ok: false,
          error: error instanceof Error ? error.message : "Connection failed",
        };
      }
    },

    saveGrant: async (workspaceId, serverId, toolName, decision) => {
      unwrapBody(
        await api.POST(
          "/api/workspaces/{workspaceId}/mcp-servers/{id}/grants",
          {
            params: { path: { workspaceId, id: serverId } },
            body: { toolName, decision },
          },
        ),
      );
      await get().fetchGrants(workspaceId, serverId);
    },

    revokeGrant: async (workspaceId, serverId, grantId) => {
      unwrapBody(
        await api.DELETE(
          "/api/workspaces/{workspaceId}/mcp-servers/{id}/grants/{grantId}",
          { params: { path: { workspaceId, id: serverId, grantId } } },
        ),
      );
      await get().fetchGrants(workspaceId, serverId);
    },
  })),
);

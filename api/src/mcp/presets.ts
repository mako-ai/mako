/**
 * MCP connector presets.
 *
 * A preset pre-fills the "Add MCP server" form for a known provider (server
 * URL, auth header fields, write-scope header). The `custom` preset is the
 * generic path — any MCP server reachable over Streamable HTTP can be added
 * with a URL plus optional headers.
 *
 * Deliberately separate from `api/src/connectors/` (data-sync connectors):
 * MCP servers are agent-runtime tooling with a different lifecycle.
 */

import type { McpAuthType, McpWriteScope } from "../database/workspace-schema";

export interface McpPresetHeaderField {
  /** HTTP header name sent to the MCP server (e.g. "Close-API-Key"). */
  name: string;
  label: string;
  /** "password" fields are encrypted at rest and masked in the UI. */
  type: "password" | "string";
  required: boolean;
  helperText?: string;
}

export interface McpPreset {
  type: string;
  label: string;
  description: string;
  /** Icon URL for the connections gallery (custom servers use favicons). */
  icon?: string;
  /** Pre-filled server URL; empty for the custom preset (user-supplied). */
  url: string;
  /** Whether the URL is editable in the UI. */
  urlEditable: boolean;
  authType: McpAuthType;
  /** Auth methods this preset supports (first entry = recommended default). */
  authOptions: McpAuthType[];
  /** Credential header fields the user must fill in (api_key auth). */
  headerFields: McpPresetHeaderField[];
  /**
   * Provider-enforced write-scope header, when the provider supports one
   * (e.g. Close's `Close-Scope`). The selected `writeScope` maps through
   * `scopeValues` to the header value.
   */
  scopeHeader?: {
    name: string;
    scopeValues: Record<McpWriteScope, string>;
  };
}

export const CLOSE_MCP_PRESET: McpPreset = {
  type: "close",
  label: "Close CRM",
  description:
    "Lets the agent search leads, manage opportunities, create contacts, and log activities in your Close organization.",
  icon: "/api/connectors/close/icon.svg",
  url: "https://mcp.close.com/mcp",
  urlEditable: false,
  authType: "oauth",
  authOptions: ["oauth", "api_key"],
  headerFields: [
    {
      name: "Close-API-Key",
      label: "Close API Key",
      type: "password",
      required: true,
      helperText: "Generate in Close under Settings → Developer → API Keys",
    },
  ],
  scopeHeader: {
    name: "Close-Scope",
    scopeValues: {
      read: "mcp.read",
      write_safe: "mcp.write_safe",
      write_destructive: "mcp.write_destructive",
    },
  },
};

export const CUSTOM_MCP_PRESET: McpPreset = {
  type: "custom",
  label: "Custom MCP server",
  description:
    "Connect any MCP server over Streamable HTTP — provide the server URL and choose OAuth, API-key, or no authentication.",
  url: "",
  urlEditable: true,
  authType: "api_key",
  authOptions: ["api_key", "oauth", "none"],
  headerFields: [],
};

export const MCP_PRESETS: Record<string, McpPreset> = {
  close: CLOSE_MCP_PRESET,
  custom: CUSTOM_MCP_PRESET,
};

export function getMcpPreset(type: string): McpPreset {
  return MCP_PRESETS[type] ?? CUSTOM_MCP_PRESET;
}

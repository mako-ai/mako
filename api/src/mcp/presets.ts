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
  /**
   * Prepended to the stored value when building the request header (e.g.
   * "Bearer " for GitHub's `Authorization` header), unless the user already
   * typed it. Lets forms ask for just the token.
   */
  valuePrefix?: string;
}

/**
 * How the OAuth client for a preset gets registered with the provider.
 *
 * - "dcr" (default): Dynamic Client Registration per the MCP authorization
 *   spec — Mako registers itself automatically on first connect (Close).
 * - "manual": the provider only accepts pre-registered confidential OAuth
 *   apps (Slack). A workspace admin must create an app with the provider and
 *   save its client ID + secret before members can connect.
 */
export interface McpPresetOAuthConfig {
  clientMode: "dcr" | "manual";
  /** Shown next to the client ID/secret form for manual-mode presets. */
  helperText?: string;
  /** Where the admin registers the OAuth app (manual mode). */
  docsUrl?: string;
  /**
   * Environment variables holding a deployment-wide OAuth client for this
   * preset (Claude-connectors model: the operator registers ONE provider app
   * and every workspace just clicks Connect). When set, workspaces skip the
   * client ID/secret form entirely; a workspace-saved client still wins so
   * self-hosters can override per workspace.
   */
  clientEnvVars?: {
    clientId: string;
    clientSecret: string;
  };
  /**
   * OAuth scopes requested per Mako write scope (least-privilege). When
   * absent, the SDK falls back to the provider's advertised
   * `scopes_supported` — fine for providers that scope via headers instead
   * (Close), wrong for providers whose scopes gate capability (Slack).
   */
  scopes?: Record<McpWriteScope, string[]>;
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
    /** Header value per write scope; an empty value omits the header. */
    scopeValues: Record<McpWriteScope, string>;
  };
  /** OAuth client registration behavior; absent = DCR (the spec default). */
  oauth?: McpPresetOAuthConfig;
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

/**
 * Slack's official hosted MCP server (`mcp.slack.com`).
 *
 * Slack does not support Dynamic Client Registration — it only accepts
 * pre-registered confidential OAuth apps. A workspace admin creates a Slack
 * app (internal, or Marketplace-published), enables "Agents & AI Apps → MCP",
 * adds Mako's callback as a redirect URL, and saves the app's client ID +
 * secret here. Each member then signs in with their own Slack account, so
 * the agent only sees what that member can see.
 *
 * Slack gates capability through granular OAuth scopes (there is no scope
 * *header* like Close's) — the requested scope set below is derived from the
 * connection's write scope so a read-only connection never even holds a
 * `chat:write` token.
 */
export const SLACK_MCP_PRESET: McpPreset = {
  type: "slack",
  label: "Slack",
  description:
    "Lets the agent search messages, read channel and thread history, look up users, and (with write access) send messages and reactions in your Slack workspace.",
  icon: "/api/mcp/presets/slack/icon.svg",
  url: "https://mcp.slack.com/mcp",
  urlEditable: false,
  authType: "oauth",
  authOptions: ["oauth"],
  headerFields: [],
  oauth: {
    clientMode: "manual",
    helperText:
      "Create a Slack app at api.slack.com/apps, enable MCP under “Agents & AI Apps”, add Mako's OAuth callback as a redirect URL, then paste the app's Client ID and Client Secret.",
    docsUrl: "https://api.slack.com/apps",
    clientEnvVars: {
      clientId: "SLACK_MCP_CLIENT_ID",
      clientSecret: "SLACK_MCP_CLIENT_SECRET",
    },
    scopes: {
      read: [
        "search:read.public",
        "search:read.private",
        "search:read.im",
        "search:read.mpim",
        "search:read.files",
        "search:read.users",
        "channels:history",
        "groups:history",
        "im:history",
        "mpim:history",
        "channels:read",
        "groups:read",
        "mpim:read",
        "users:read",
        "users:read.email",
        "canvases:read",
        "reactions:read",
        "emoji:read",
        "files:read",
      ],
      write_safe: [
        "search:read.public",
        "search:read.private",
        "search:read.im",
        "search:read.mpim",
        "search:read.files",
        "search:read.users",
        "channels:history",
        "groups:history",
        "im:history",
        "mpim:history",
        "channels:read",
        "groups:read",
        "mpim:read",
        "users:read",
        "users:read.email",
        "canvases:read",
        "reactions:read",
        "emoji:read",
        "files:read",
        "chat:write",
        "reactions:write",
        "canvases:write",
      ],
      write_destructive: [
        "search:read.public",
        "search:read.private",
        "search:read.im",
        "search:read.mpim",
        "search:read.files",
        "search:read.users",
        "channels:history",
        "groups:history",
        "im:history",
        "mpim:history",
        "channels:read",
        "groups:read",
        "mpim:read",
        "users:read",
        "users:read.email",
        "canvases:read",
        "reactions:read",
        "emoji:read",
        "files:read",
        "chat:write",
        "reactions:write",
        "canvases:write",
        "channels:write",
        "groups:write",
        "im:write",
        "mpim:write",
      ],
    },
  },
};

/**
 * GitHub's official hosted MCP server (`api.githubcopilot.com/mcp/`).
 *
 * Two auth modes:
 *  - OAuth: GitHub does not support Dynamic Client Registration, so — like
 *    Slack — the flow needs a pre-registered OAuth app (deployment-wide via
 *    `GITHUB_MCP_CLIENT_ID`/`GITHUB_MCP_CLIENT_SECRET`, or saved per
 *    workspace by an admin). Each member then signs in with their own GitHub
 *    account.
 *  - Personal access token: the server accepts `Authorization: Bearer <PAT>`;
 *    the form asks for just the token and the "Bearer " prefix is applied
 *    when building headers (`valuePrefix`).
 *
 * Read-only connections are enforced server-side through GitHub's
 * `X-MCP-Readonly: true` header (GitHub's coarse OAuth scopes can't express
 * read-only repo access, so no per-scope OAuth scope sets here — the SDK
 * falls back to the provider's advertised scopes).
 */
export const GITHUB_MCP_PRESET: McpPreset = {
  type: "github",
  label: "GitHub",
  description:
    "Lets the agent browse repositories, read code and issues, search across GitHub, and (with write access) create issues, branches, and pull requests as you.",
  icon: "/api/mcp/presets/github/icon.svg",
  url: "https://api.githubcopilot.com/mcp/",
  urlEditable: false,
  authType: "oauth",
  authOptions: ["oauth", "api_key"],
  headerFields: [
    {
      name: "Authorization",
      label: "GitHub Personal Access Token",
      type: "password",
      required: true,
      valuePrefix: "Bearer ",
      helperText:
        "Generate on GitHub under Settings → Developer settings → Personal access tokens — paste just the token",
    },
  ],
  scopeHeader: {
    name: "X-MCP-Readonly",
    scopeValues: {
      read: "true",
      // Empty = header omitted: GitHub's flag is only meaningful when true,
      // and write capability is then governed by the token's own permissions.
      write_safe: "",
      write_destructive: "",
    },
  },
  oauth: {
    clientMode: "manual",
    helperText:
      "Create a GitHub OAuth App under Settings → Developer settings → OAuth Apps, set Mako's OAuth callback as the Authorization callback URL, then paste the app's Client ID and Client Secret.",
    docsUrl: "https://github.com/settings/developers",
    clientEnvVars: {
      clientId: "GITHUB_MCP_CLIENT_ID",
      clientSecret: "GITHUB_MCP_CLIENT_SECRET",
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
  slack: SLACK_MCP_PRESET,
  github: GITHUB_MCP_PRESET,
  custom: CUSTOM_MCP_PRESET,
};

export function getMcpPreset(type: string): McpPreset {
  return MCP_PRESETS[type] ?? CUSTOM_MCP_PRESET;
}

/** OAuth scopes to request for a server, per its preset + write scope. */
export function mcpPresetOAuthScope(
  preset: McpPreset,
  writeScope: McpWriteScope,
): string | undefined {
  const scopes = preset.oauth?.scopes?.[writeScope];
  return scopes && scopes.length > 0 ? scopes.join(" ") : undefined;
}

/**
 * The deployment-wide OAuth client for a preset, read from the environment
 * (e.g. `SLACK_MCP_CLIENT_ID` / `SLACK_MCP_CLIENT_SECRET`). Undefined when
 * the preset has no env client configured — workspaces then supply their own.
 */
export function mcpPresetEnvOAuthClient(
  preset: McpPreset,
): { client_id: string; client_secret?: string } | undefined {
  const vars = preset.oauth?.clientEnvVars;
  if (!vars) return undefined;
  const clientId = process.env[vars.clientId]?.trim();
  if (!clientId) return undefined;
  const clientSecret = process.env[vars.clientSecret]?.trim();
  return {
    client_id: clientId,
    ...(clientSecret ? { client_secret: clientSecret } : {}),
  };
}

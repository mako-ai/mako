/**
 * ACP coding-agent provider registry.
 *
 * ACP itself is provider-agnostic; each entry here is just "which stdio
 * adapter binary to spawn" plus setup/auth hints for the UI.
 */

export type AcpProviderId = "claude" | "codex";

export interface AcpProviderDefinition {
  id: AcpProviderId;
  label: string;
  description: string;
  /** Prefer these commands in order when resolving the adapter binary. */
  commands: string[];
  /** npm package useful for `npx <package>` fallback. */
  npxPackage: string;
  /** Human-facing install hint shown when the adapter is missing. */
  installHint: string;
  /** Auth product the adapter typically uses. */
  authProduct: string;
}

export const ACP_PROVIDERS: Record<AcpProviderId, AcpProviderDefinition> = {
  claude: {
    id: "claude",
    label: "Claude Code",
    description: "Anthropic Claude Code via ACP adapter (Claude Pro/Max login).",
    commands: [
      "claude-agent-acp",
      "claude-code-acp",
      "@agentclientprotocol/claude-agent-acp",
    ],
    npxPackage: "@agentclientprotocol/claude-agent-acp",
    installHint:
      "Mako can install the Claude ACP adapter automatically — use Install in Chat, or: npm i -g @agentclientprotocol/claude-agent-acp",
    authProduct: "Claude Pro/Max",
  },
  codex: {
    id: "codex",
    label: "Codex (ChatGPT)",
    description:
      "OpenAI Codex via ACP adapter (ChatGPT subscription or API key).",
    commands: [
      "codex-acp",
      "@agentclientprotocol/codex-acp",
      // Retired package — keep as last-resort fallback for old installs.
      "@zed-industries/codex-acp",
    ],
    npxPackage: "@agentclientprotocol/codex-acp",
    installHint:
      "Mako can install Codex CLI + ACP adapter automatically — use Install in Chat, or: npm i -g @openai/codex @agentclientprotocol/codex-acp",
    authProduct: "ChatGPT / OpenAI API",
  },
};

export const ACP_PROVIDER_IDS = Object.keys(ACP_PROVIDERS) as AcpProviderId[];

export function isAcpProviderId(value: string): value is AcpProviderId {
  return value in ACP_PROVIDERS;
}

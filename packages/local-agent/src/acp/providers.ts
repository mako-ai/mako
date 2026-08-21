/**
 * ACP coding-agent provider registry.
 *
 * ACP itself is provider-agnostic; each entry here is just "which stdio
 * adapter binary to spawn" plus setup/auth hints for the UI.
 */

export type AcpProviderId = "claude" | "codex" | "cursor";

export interface AcpProviderDefinition {
  id: AcpProviderId;
  label: string;
  description: string;
  /** Prefer these commands in order when resolving the adapter binary. */
  commands: string[];
  /**
   * Args appended when a PATH command resolves (e.g. Cursor CLI speaks ACP
   * via the `acp` subcommand: `cursor-agent acp`). Adapter-only binaries
   * (claude-agent-acp, codex-acp) omit this.
   */
  commandArgs?: string[];
  /**
   * npm package useful for `npx <package>` fallback and `npm i -g` ensure.
   * `null` for CLIs not distributed via npm (Cursor) — no npx fallback and
   * ensure-adapter never runs npm for them.
   */
  npxPackage: string | null;
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
  cursor: {
    id: "cursor",
    label: "Cursor Agent",
    description:
      "Cursor CLI via native ACP (`cursor-agent acp`) — Grok, Composer and " +
      "more on your Cursor subscription.",
    // Cursor CLI ships ACP built in; newer builds install the binary as
    // `agent`, older ones as `cursor-agent`. Not distributed via npm.
    commands: ["cursor-agent", "agent"],
    commandArgs: ["acp"],
    npxPackage: null,
    installHint:
      "Install Cursor CLI in Terminal: curl https://cursor.com/install -fsS | bash — then run `cursor-agent login` (Cursor subscription).",
    authProduct: "Cursor subscription",
  },
};

export const ACP_PROVIDER_IDS = Object.keys(ACP_PROVIDERS) as AcpProviderId[];

export function isAcpProviderId(value: string): value is AcpProviderId {
  return value in ACP_PROVIDERS;
}

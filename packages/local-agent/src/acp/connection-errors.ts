/** Errors from @agentclientprotocol/sdk when the adapter stdio pipe dies. */
export function isAcpConnectionClosedError(error: unknown): boolean {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === "string"
        ? error
        : String(error ?? "");
  return /ACP connection closed|connection closed|EPIPE|ECONNRESET/i.test(
    message,
  );
}

export function acpReconnectMessage(providerLabel: string): string {
  return (
    `${providerLabel} connection dropped (adapter process exited). ` +
    `Mako will start a fresh local session on the next message.`
  );
}

/**
 * npx often dies with ENOTEMPTY when its cache is corrupted mid-install.
 * Prefer a global adapter install so we stop hitting ~/.npm/_npx on every turn.
 */
export function explainAdapterLaunchFailure(stderrOrMessage: string): string | null {
  const text = stderrOrMessage || "";
  if (!/ENOTEMPTY|npm error code ENOTEMPTY|_npx/i.test(text)) return null;
  const isCodex = /codex/i.test(text);
  const pkg = isCodex
    ? "@agentclientprotocol/codex-acp"
    : "@agentclientprotocol/claude-agent-acp";
  const label = isCodex ? "Codex" : "Claude";
  return (
    `${label} ACP adapter failed to start because the npm/npx cache is corrupted ` +
    `(ENOTEMPTY). Fix in Terminal, then retry Enable workspace tools:\n` +
    `  rm -rf ~/.npm/_npx\n` +
    `  npm i -g ${pkg}\n` +
    "Using a global install avoids npx cache races on every Chat turn."
  );
}

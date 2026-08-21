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

/**
 * Adapter stderr that is noisy / developer-only and must not be shown as a
 * red Chat/Settings error (Claude SDK tool-shadow warnings, EMFILE watchers…).
 */
export function isAdapterStderrNoise(text: string): boolean {
  const t = text || "";
  if (!t.trim()) return true;
  if (/CLAUDE_SDK_CAN_USE_TOOL_SHADOWED|canUseTool will not be invoked/i.test(t)) {
    return true;
  }
  if (/Bare allowedTools entries auto-approve/i.test(t)) return true;
  if (/EMFILE|too many open files|MaxListenersExceededWarning/i.test(t)) {
    return true;
  }
  if (/DeprecationWarning|ExperimentalWarning/i.test(t) && t.length < 400) {
    return true;
  }
  // Lone JSON-RPC noise without an actionable tip.
  if (/^Invalid params\s*$/i.test(t.trim())) return true;
  return false;
}

/**
 * Strip noise lines from adapter stderr before exposing to the UI.
 * Returns null when nothing actionable remains.
 */
export function sanitizeAdapterStderrForUi(
  text: string | null | undefined,
): string | null {
  const raw = (text || "").trim();
  if (!raw) return null;
  if (isAdapterStderrNoise(raw)) return null;
  const kept = raw
    .split("\n")
    .filter(line => !isAdapterStderrNoise(line))
    .join("\n")
    .trim();
  if (!kept || isAdapterStderrNoise(kept)) return null;
  return kept.slice(-800);
}

/**
 * Prefer a short human tip over raw adapter/JSON-RPC dumps for Chat banners.
 */
export function userFacingAcpError(
  message: string,
  options?: { providerId?: "claude" | "codex" | "cursor" },
): string {
  const raw = (message || "").trim();
  if (!raw) return "Something went wrong with the local agent.";
  const cleaned = sanitizeAdapterStderrForUi(raw) || raw;
  // Drop appended stderr noise while keeping the first actionable line.
  const primary = cleaned
    .split("\n")
    .find(line => line.trim() && !isAdapterStderrNoise(line))
    ?.trim();
  const text = primary || cleaned;
  if (/Invalid params/i.test(text) && options?.providerId === "codex") {
    return (
      "Codex could not apply that model setting. Pick Codex · GPT-5.6 Terra " +
      "(or Luna) in the Chat model dropdown, then Enable workspace tools again."
    );
  }
  if (/Invalid params/i.test(text) && options?.providerId === "cursor") {
    return (
      "Cursor Agent could not apply that setting. Pick Cursor · Grok (local) " +
      "again in the Chat model dropdown, or update Cursor CLI " +
      "(`cursor-agent update`), then Enable workspace tools again."
    );
  }
  if (/Invalid params/i.test(text) && options?.providerId === "claude") {
    return (
      "Claude could not apply that setting. Pick Claude Code again in Chat, " +
      "or Update the adapter in Settings → Coding Agents."
    );
  }
  if (/Invalid params/i.test(text) && /CLAUDE_SDK|canUseTool|allowedTools/i.test(raw)) {
    // Claude SDK warning leaked into a shared error while on another provider.
    return (
      "Local tools hit a transient adapter warning. Click Enable workspace " +
      "tools again (or start a New chat)."
    );
  }
  return text.length > 600 ? `${text.slice(0, 600)}…` : text;
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

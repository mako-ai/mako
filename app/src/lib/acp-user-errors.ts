/**
 * Client-side filter for Local Agent ACP errors shown in Chat / Settings.
 * Mirrors packages/local-agent/src/acp/connection-errors.ts — keep patterns in sync.
 */

export function isAcpAdapterNoise(text: string): boolean {
  const t = text || "";
  if (!t.trim()) return true;
  if (
    /CLAUDE_SDK_CAN_USE_TOOL_SHADOWED|canUseTool will not be invoked/i.test(t)
  ) {
    return true;
  }
  if (/Bare allowedTools entries auto-approve/i.test(t)) return true;
  if (/EMFILE|too many open files|MaxListenersExceededWarning/i.test(t)) {
    return true;
  }
  if (/DeprecationWarning|ExperimentalWarning/i.test(t) && t.length < 400) {
    return true;
  }
  if (/^Invalid params\s*$/i.test(t.trim())) return true;
  return false;
}

export function sanitizeAcpUserError(
  message: string | null | undefined,
  options?: { providerId?: "claude" | "codex" | null },
): string | null {
  const raw = (message || "").trim();
  if (!raw) return null;
  if (isAcpAdapterNoise(raw)) {
    if (options?.providerId === "codex") {
      return (
        "Codex could not apply that model setting. Pick Codex · GPT-5.6 Terra " +
        "(or Luna), then Enable workspace tools again."
      );
    }
    return null;
  }
  const kept = raw
    .split("\n")
    .filter(line => !isAcpAdapterNoise(line))
    .join("\n")
    .trim();
  if (!kept) return null;
  if (
    /Invalid params/i.test(kept) &&
    /CLAUDE_SDK|canUseTool|allowedTools/i.test(raw)
  ) {
    return (
      "Local tools hit a transient adapter warning. Click Enable workspace " +
      "tools again (or start a New chat)."
    );
  }
  if (/Invalid params/i.test(kept) && options?.providerId === "codex") {
    return (
      "Codex could not apply that model setting. Pick Codex · GPT-5.6 Terra " +
      "(or Luna), then Enable workspace tools again."
    );
  }
  return kept.length > 600 ? `${kept.slice(0, 600)}…` : kept;
}

/** True when Terminal sign-in guidance should be hidden (already logged in). */
export function shouldClearAcpAuthGuidance(
  guidance: string | null | undefined,
  provider:
    | {
        cliLoggedIn?: boolean;
        connected?: boolean;
        authRequired?: boolean;
      }
    | null
    | undefined,
): boolean {
  if (!guidance?.trim() || !provider) return false;
  const signedIn =
    provider.cliLoggedIn === true ||
    (provider.connected === true && provider.authRequired === false);
  if (!signedIn) return false;
  return /Terminal|codex login|claude auth|Complete sign-in|Sign in with/i.test(
    guidance,
  );
}

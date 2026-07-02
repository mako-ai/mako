// ── Per-tab chat session persistence ─────────────────────────────
// sessionStorage scopes the active chat to the browser tab: a refresh
// restores (and reattaches to) the same chat, while new tabs start blank.

const CHAT_SESSION_STORAGE_KEY = "mako:active-chat";

export interface StoredChatSession {
  chatId: string;
  workspaceId: string;
}

export function readStoredChatSession(): StoredChatSession | null {
  try {
    const raw = sessionStorage.getItem(CHAT_SESSION_STORAGE_KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<StoredChatSession>;
    if (
      typeof parsed.chatId === "string" &&
      /^[0-9a-fA-F]{24}$/.test(parsed.chatId) &&
      typeof parsed.workspaceId === "string"
    ) {
      return { chatId: parsed.chatId, workspaceId: parsed.workspaceId };
    }
  } catch {
    /* sessionStorage unavailable or corrupted entry */
  }
  return null;
}

export function writeStoredChatSession(session: StoredChatSession): void {
  try {
    sessionStorage.setItem(CHAT_SESSION_STORAGE_KEY, JSON.stringify(session));
  } catch {
    /* ignore storage failures (private mode, quota) */
  }
}

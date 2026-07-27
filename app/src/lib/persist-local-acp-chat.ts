/**
 * Persist a Local Agent ACP chat transcript into workspace History
 * (same Chat collection as cloud gateway chats).
 */
import type { UIMessage } from "ai";
import { api } from "../api/client";

export interface LocalAcpChatBinding {
  providerId: string;
  sessionId: string;
  modelId: string;
}

export async function persistLocalAcpChat(args: {
  workspaceId: string;
  chatId: string;
  messages: UIMessage[];
  localAcp?: LocalAcpChatBinding | null;
}): Promise<boolean> {
  const { workspaceId, chatId, messages, localAcp } = args;
  if (!workspaceId || !chatId || messages.length === 0) return false;

  try {
    const { response } = await api.PUT(
      "/api/workspaces/{workspaceId}/chats/{id}/messages",
      {
        params: { path: { workspaceId, id: chatId } },
        body: {
          messages: messages as unknown as Array<Record<string, unknown>>,
          localAcp,
        },
      },
    );
    return response.ok;
  } catch {
    return false;
  }
}

/** Drop a persisted ACP binding so History reopen does not force local Claude/Codex. */
export async function clearLocalAcpChatBinding(args: {
  workspaceId: string;
  chatId: string;
  messages: UIMessage[];
}): Promise<boolean> {
  return persistLocalAcpChat({ ...args, localAcp: null });
}

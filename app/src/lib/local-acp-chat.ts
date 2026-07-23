/**
 * Run one main-Chat turn through Local Agent ACP (Claude Code / Codex).
 */
import type { UIMessage } from "ai";
import { generateObjectId } from "../utils/objectId";
import { acpClient } from "./acp-client";
import {
  isLocalAcpModelId,
  localAcpModelIdToProviderId,
} from "./local-acp-models";
import { useAcpStore } from "../store/acpStore";
import type { AcpProviderId } from "./acp-types";

function withAssistantText(message: UIMessage, text: string): UIMessage {
  return {
    ...message,
    parts: [{ type: "text", text }],
  };
}

export async function ensureAcpSessionForProvider(
  providerId: AcpProviderId,
): Promise<string> {
  const store = useAcpStore.getState();
  if (!store.status) {
    await store.refreshStatus();
  }
  const provider = useAcpStore
    .getState()
    .status?.providers.find(p => p.id === providerId);
  if (!provider?.adapterFound) {
    throw new Error(
      provider?.installHint ||
        `${providerId} ACP adapter not found. Install it and restart the Local Agent.`,
    );
  }

  const existing = useAcpStore
    .getState()
    .sessions.find(s => s.providerId === providerId);
  if (existing) {
    useAcpStore.getState().setActiveSession(existing.id);
    return existing.id;
  }

  useAcpStore.getState().setSelectedProvider(providerId);
  const created = await useAcpStore.getState().createSession();
  if (!created) {
    throw new Error(
      useAcpStore.getState().error || "Failed to create local ACP session",
    );
  }
  return created.id;
}

export interface LocalAcpChatTurnArgs {
  modelId: string;
  text: string;
  setMessages: (
    updater: UIMessage[] | ((prev: UIMessage[]) => UIMessage[]),
  ) => void;
  signal?: AbortSignal;
}

/**
 * Appends user + assistant messages to the main Chat transcript and streams
 * ACP session/update chunks into the assistant message. Returns true when the
 * model id is a local ACP model (caller should skip cloud transport).
 */
export async function runLocalAcpChatTurn(
  args: LocalAcpChatTurnArgs,
): Promise<boolean> {
  const { modelId, text, setMessages, signal } = args;
  if (!isLocalAcpModelId(modelId)) return false;

  const providerId = localAcpModelIdToProviderId(modelId);
  if (!providerId) {
    throw new Error(`Unknown local ACP model: ${modelId}`);
  }

  const trimmed = text.trim();
  if (!trimmed) return true;

  const userId = generateObjectId();
  const assistantId = generateObjectId();
  setMessages(prev => [
    ...prev,
    {
      id: userId,
      role: "user",
      parts: [{ type: "text", text: trimmed }],
    },
    {
      id: assistantId,
      role: "assistant",
      parts: [{ type: "text", text: "" }],
    },
  ]);

  let assistantText = "";
  const patchAssistant = (nextText: string) => {
    assistantText = nextText;
    setMessages(prev =>
      prev.map(m =>
        m.id === assistantId ? withAssistantText(m, nextText) : m,
      ),
    );
  };

  try {
    if (signal?.aborted) {
      throw new DOMException("Cancelled", "AbortError");
    }

    const sessionId = await ensureAcpSessionForProvider(providerId);

    const unsub = acpClient.subscribeEvents(
      sessionId,
      event => {
        if (signal?.aborted) return;
        if (event.type === "session_update") {
          const update = event.update as {
            sessionUpdate?: string;
            content?: { type?: string; text?: string };
            title?: string;
            status?: string;
          };
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content?.type === "text" &&
            update.content.text
          ) {
            patchAssistant(assistantText + update.content.text);
          } else if (update.sessionUpdate === "tool_call") {
            patchAssistant(
              `${assistantText}\n\n🔧 ${update.title || "Tool"} (${update.status || "pending"})\n`,
            );
          }
        } else if (event.type === "error") {
          patchAssistant(`${assistantText}\n\nError: ${event.message}`);
        }
      },
      err => {
        if (signal?.aborted) return;
        patchAssistant(`${assistantText}\n\n(${err.message})`);
      },
    );

    try {
      await acpClient.prompt(sessionId, trimmed);
      if (!assistantText.trim()) {
        patchAssistant("(No response from local agent)");
      }
    } finally {
      unsub();
    }
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      patchAssistant(
        assistantText ? `${assistantText}\n\n_Stopped._` : "_Stopped._",
      );
      return true;
    }
    const message =
      error instanceof Error ? error.message : "Local ACP prompt failed";
    patchAssistant(
      assistantText
        ? `${assistantText}\n\nError: ${message}`
        : `Error: ${message}`,
    );
    throw error;
  }

  return true;
}

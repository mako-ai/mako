/**
 * Run one main-Chat turn through Local Agent ACP (Claude Code / Codex).
 * Tool calls become `dynamic-tool` UIMessage parts so Chat uses the same
 * StreamingToolCard UI as the in-app agent.
 */
import type { UIMessage } from "ai";
import { generateObjectId } from "../utils/objectId";
import { acpClient } from "./acp-client";
import {
  isLocalAcpModelId,
  localAcpModelIdToProviderId,
} from "./local-acp-models";
import {
  appendAssistantText,
  getAssistantParts,
  setAssistantErrorText,
  upsertAcpToolPart,
  type AcpToolUpdate,
} from "./local-acp-parts";
import { useAcpStore } from "../store/acpStore";
import type { AcpProviderId } from "./acp-types";

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

  // Prefer a session that already has Mako MCP attached so Chat gets DB tools.
  const withMcp = useAcpStore
    .getState()
    .sessions.find(s => s.providerId === providerId && s.makoMcpAttached);
  if (withMcp) {
    useAcpStore.getState().setActiveSession(withMcp.id);
    return withMcp.id;
  }

  useAcpStore.getState().setSelectedProvider(providerId);
  const created = await useAcpStore.getState().createSession();
  if (!created) {
    throw new Error(
      useAcpStore.getState().error || "Failed to create local ACP session",
    );
  }
  if (!created.makoMcpAttached) {
    throw new Error(
      useAcpStore.getState().error ||
        "Local session started without Mako data tools. Check that you are signed in and Local Agent can reach this workspace.",
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

  const patchAssistantParts = (
    updater: (
      parts: ReturnType<typeof getAssistantParts>,
    ) => ReturnType<typeof getAssistantParts>,
  ) => {
    setMessages(prev =>
      prev.map(m => {
        if (m.id !== assistantId) return m;
        return {
          ...m,
          parts: updater(getAssistantParts(m)) as UIMessage["parts"],
        };
      }),
    );
  };

  try {
    if (signal?.aborted) {
      throw new DOMException("Cancelled", "AbortError");
    }

    const sessionId = await ensureAcpSessionForProvider(providerId);
    // Keep the store subscription alive for permission prompts in Chat.
    useAcpStore.getState().ensureEventSubscription(sessionId);

    const unsub = acpClient.subscribeEvents(
      sessionId,
      event => {
        if (signal?.aborted) return;
        if (event.type === "session_update") {
          const update = event.update as AcpToolUpdate & {
            content?: { type?: string; text?: string };
          };
          if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content?.type === "text" &&
            typeof update.content.text === "string" &&
            update.content.text
          ) {
            const chunk = update.content.text;
            patchAssistantParts(parts => appendAssistantText(parts, chunk));
          } else if (
            update.sessionUpdate === "tool_call" ||
            update.sessionUpdate === "tool_call_update"
          ) {
            patchAssistantParts(parts => upsertAcpToolPart(parts, update));
          }
        } else if (event.type === "permission_request") {
          // Store path (ensureEventSubscription) also receives this; no-op here.
        } else if (event.type === "error") {
          patchAssistantParts(parts =>
            setAssistantErrorText(parts, `Error: ${event.message}`),
          );
        }
      },
      err => {
        if (signal?.aborted) return;
        patchAssistantParts(parts =>
          setAssistantErrorText(parts, `(${err.message})`),
        );
      },
    );

    try {
      await acpClient.prompt(sessionId, trimmed);
      setMessages(prev => {
        const assistant = prev.find(m => m.id === assistantId);
        const parts = getAssistantParts(assistant);
        const hasText = parts.some(
          p =>
            p.type === "text" &&
            String((p as { text?: string }).text || "").trim(),
        );
        const hasTool = parts.some(p => p.type === "dynamic-tool");
        if (hasText || hasTool) return prev;
        return prev.map(m =>
          m.id === assistantId
            ? {
                ...m,
                parts: [
                  { type: "text", text: "(No response from local agent)" },
                ] as UIMessage["parts"],
              }
            : m,
        );
      });
    } finally {
      unsub();
    }
  } catch (error) {
    if (
      signal?.aborted ||
      (error instanceof DOMException && error.name === "AbortError")
    ) {
      patchAssistantParts(parts => setAssistantErrorText(parts, "_Stopped._"));
      return true;
    }
    const message =
      error instanceof Error ? error.message : "Local ACP prompt failed";
    patchAssistantParts(parts =>
      setAssistantErrorText(parts, `Error: ${message}`),
    );
    throw error;
  }

  return true;
}

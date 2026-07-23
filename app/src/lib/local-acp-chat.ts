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
import {
  persistLocalAcpChat,
  type LocalAcpChatBinding,
} from "./persist-local-acp-chat";
import { useAcpStore } from "../store/acpStore";
import type { AcpProviderId } from "./acp-types";

export async function ensureAcpSessionForProvider(
  providerId: AcpProviderId,
  workspaceId?: string,
  preferredSessionId?: string,
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

  // Prefer the session bound to this History chat (reopen / continue).
  if (preferredSessionId) {
    let preferred = useAcpStore
      .getState()
      .sessions.find(
        s =>
          s.id === preferredSessionId &&
          s.providerId === providerId &&
          s.makoMcpAttached,
      );
    if (!preferred) {
      await useAcpStore.getState().refreshSessions();
      preferred = useAcpStore
        .getState()
        .sessions.find(
          s =>
            s.id === preferredSessionId &&
            s.providerId === providerId &&
            s.makoMcpAttached,
        );
    }
    if (preferred) {
      useAcpStore.getState().setActiveSession(preferred.id);
      return preferred.id;
    }
  }

  // Prefer a session that already has Mako MCP attached so Chat gets DB tools.
  // Ignore old sessions that used the unauthenticated Claude.ai "Mako" path.
  const withMcp = useAcpStore
    .getState()
    .sessions.find(s => s.providerId === providerId && s.makoMcpAttached);
  if (withMcp) {
    useAcpStore.getState().setActiveSession(withMcp.id);
    return withMcp.id;
  }

  useAcpStore.getState().setSelectedProvider(providerId);
  const created = await useAcpStore.getState().createSession({
    workspaceId,
    requireMakoMcp: true,
  });
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
  workspaceId?: string;
  /** Mako History chat id — when set, transcript is persisted after the turn. */
  chatId?: string;
  /** Resume the ACP process session previously bound to this chat. */
  preferredSessionId?: string;
  setMessages: (
    updater: UIMessage[] | ((prev: UIMessage[]) => UIMessage[]),
  ) => void;
  signal?: AbortSignal;
  /** Called after a successful persist so History can refresh / rebind ACP. */
  onPersisted?: (binding?: LocalAcpChatBinding) => void;
}

/**
 * Appends user + assistant messages to the main Chat transcript and streams
 * ACP session/update chunks into the assistant message. Returns true when the
 * model id is a local ACP model (caller should skip cloud transport).
 */
export async function runLocalAcpChatTurn(
  args: LocalAcpChatTurnArgs,
): Promise<boolean> {
  const {
    modelId,
    text,
    workspaceId,
    chatId,
    preferredSessionId,
    setMessages,
    signal,
    onPersisted,
  } = args;
  if (!isLocalAcpModelId(modelId)) return false;

  const providerId = localAcpModelIdToProviderId(modelId);
  if (!providerId) {
    throw new Error(`Unknown local ACP model: ${modelId}`);
  }

  const trimmed = text.trim();
  if (!trimmed) return true;

  // Mirror message updates synchronously so we can persist after the turn
  // without racing React's batched setState flush.
  let mirrored: UIMessage[] | null = null;
  const applyMessages = (
    updater: UIMessage[] | ((prev: UIMessage[]) => UIMessage[]),
  ) => {
    setMessages(prev => {
      const base = mirrored ?? prev;
      const next = typeof updater === "function" ? updater(base) : updater;
      mirrored = next;
      return next;
    });
  };

  const userId = generateObjectId();
  const assistantId = generateObjectId();
  applyMessages(prev => [
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
    applyMessages(prev =>
      prev.map(m => {
        if (m.id !== assistantId) return m;
        return {
          ...m,
          parts: updater(getAssistantParts(m)) as UIMessage["parts"],
        };
      }),
    );
  };

  let sessionId: string | null = null;

  const persistIfPossible = async () => {
    if (!workspaceId || !chatId || !mirrored || mirrored.length === 0) return;
    const binding: LocalAcpChatBinding | undefined = sessionId
      ? { providerId, sessionId, modelId }
      : undefined;
    const ok = await persistLocalAcpChat({
      workspaceId,
      chatId,
      messages: mirrored,
      localAcp: binding,
    });
    if (ok) onPersisted?.(binding);
  };

  try {
    if (signal?.aborted) {
      throw new DOMException("Cancelled", "AbortError");
    }

    sessionId = await ensureAcpSessionForProvider(
      providerId,
      workspaceId,
      preferredSessionId,
    );
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
          // HITL in Chat — surface Allow/Deny above the composer.
          const activeSessionId = sessionId;
          if (!activeSessionId) return;
          useAcpStore.getState().ingestPermissionRequest(activeSessionId, {
            requestId: event.requestId,
            toolCall: event.toolCall,
            options: event.options || [],
          });
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
      applyMessages(prev => {
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
      await persistIfPossible();
      return true;
    }
    const message =
      error instanceof Error ? error.message : "Local ACP prompt failed";
    patchAssistantParts(parts =>
      setAssistantErrorText(parts, `Error: ${message}`),
    );
    await persistIfPossible();
    throw error;
  }

  await persistIfPossible();
  return true;
}

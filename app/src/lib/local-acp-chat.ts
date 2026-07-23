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
  localAcpModelPreference,
} from "./local-acp-models";
import {
  appendAssistantText,
  getAssistantParts,
  setAssistantErrorText,
  upsertAcpToolPart,
  resolveAcpToolName,
  type AcpToolUpdate,
} from "./local-acp-parts";
import { isAcpConnectionClosedError } from "./acp-connection-errors";
import {
  persistLocalAcpChat,
  type LocalAcpChatBinding,
} from "./persist-local-acp-chat";
import { useAcpStore } from "../store/acpStore";
import { useAppStore } from "../store/appStore";
import { focusAppTab } from "../app-runtime/shell";
import type { AcpProviderId } from "./acp-types";

/** When MCP create_app completes, open the app tab so the user sees the scaffold. */
function maybeOpenCreatedApp(
  workspaceId: string | undefined,
  update: AcpToolUpdate,
): void {
  if (!workspaceId || update.status !== "completed") return;
  if (resolveAcpToolName(update) !== "create_app") return;
  const output = update.rawOutput ?? update.content;
  const rec =
    output && typeof output === "object"
      ? (output as Record<string, unknown>)
      : null;
  const nested =
    rec?.data && typeof rec.data === "object"
      ? (rec.data as Record<string, unknown>)
      : null;
  const appId =
    (typeof rec?.appId === "string" && rec.appId) ||
    (typeof nested?.appId === "string" && nested.appId) ||
    null;
  if (!appId) return;
  const titleFromRec =
    typeof rec?.title === "string" && rec.title.trim() ? rec.title : null;
  const titleFromNested =
    typeof nested?.title === "string" && nested.title.trim()
      ? nested.title
      : null;
  const title = titleFromRec || titleFromNested || "App";
  void useAppStore
    .getState()
    .fetchApp(workspaceId, appId)
    .then(app => {
      focusAppTab(appId, app?.title || title);
    })
    .catch(() => {
      focusAppTab(appId, title);
    });
}

async function applyModelPreference(
  sessionId: string,
  modelPreference: string | null | undefined,
): Promise<void> {
  const preferred = modelPreference?.trim();
  if (!preferred) return;
  const session = useAcpStore.getState().sessions.find(s => s.id === sessionId);
  // Skip no-op switches (adapter may already be on this model / alias).
  if (
    session?.currentModel &&
    (session.currentModel === preferred ||
      session.currentModel.toLowerCase().includes(preferred.toLowerCase()) ||
      preferred.toLowerCase().includes(session.currentModel.toLowerCase()))
  ) {
    return;
  }
  const updated = await useAcpStore
    .getState()
    .setSessionModel(sessionId, preferred);
  if (!updated) {
    throw new Error(
      useAcpStore.getState().error ||
        `Failed to switch local model to ${preferred}`,
    );
  }
}

export async function ensureAcpSessionForProvider(
  providerId: AcpProviderId,
  workspaceId?: string,
  preferredSessionId?: string,
  options?: { forceNew?: boolean; model?: string | null },
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

  // Always reconcile with Local Agent — Desktop/agent restarts leave stale ids.
  await useAcpStore.getState().refreshSessions();
  const liveIds = new Set(useAcpStore.getState().sessions.map(s => s.id));
  const modelPreference = options?.model?.trim() || null;

  if (
    !options?.forceNew &&
    preferredSessionId &&
    liveIds.has(preferredSessionId)
  ) {
    const preferred = useAcpStore
      .getState()
      .sessions.find(
        s =>
          s.id === preferredSessionId &&
          s.providerId === providerId &&
          s.makoMcpAttached,
      );
    if (preferred) {
      useAcpStore.getState().setActiveSession(preferred.id);
      await applyModelPreference(preferred.id, modelPreference);
      return preferred.id;
    }
  }

  if (!options?.forceNew) {
    const withMcp = useAcpStore
      .getState()
      .sessions.find(s => s.providerId === providerId && s.makoMcpAttached);
    if (withMcp && liveIds.has(withMcp.id)) {
      useAcpStore.getState().setActiveSession(withMcp.id);
      await applyModelPreference(withMcp.id, modelPreference);
      return withMcp.id;
    }
  }

  useAcpStore.getState().setSelectedProvider(providerId);
  const created = await useAcpStore.getState().createSession({
    workspaceId,
    requireMakoMcp: true,
    model: modelPreference || undefined,
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

  const modelPreference = localAcpModelPreference(modelId);

  const runAgainstSession = async (forceNew: boolean) => {
    sessionId = await ensureAcpSessionForProvider(
      providerId,
      workspaceId,
      forceNew ? undefined : preferredSessionId,
      { forceNew, model: modelPreference },
    );
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
            maybeOpenCreatedApp(workspaceId, update);
          }
        } else if (event.type === "permission_request") {
          const activeSessionId = sessionId;
          if (!activeSessionId) return;
          useAcpStore.getState().ingestPermissionRequest(activeSessionId, {
            requestId: event.requestId,
            toolCall: event.toolCall,
            options: event.options || [],
          });
        } else if (
          event.type === "session_invalidated" ||
          event.type === "error"
        ) {
          // Recoverable closes are retried below; avoid painting a fatal line
          // that races the automatic reconnect.
          if (!isAcpConnectionClosedError(event.message)) {
            patchAssistantParts(parts =>
              setAssistantErrorText(parts, `Error: ${event.message}`),
            );
          }
        }
      },
      err => {
        if (signal?.aborted) return;
        if (!isAcpConnectionClosedError(err)) {
          patchAssistantParts(parts =>
            setAssistantErrorText(parts, `(${err.message})`),
          );
        }
      },
    );

    const activeSessionId = sessionId;
    const onAbort = () => {
      void acpClient.cancel(activeSessionId).catch(() => undefined);
    };
    if (signal?.aborted) {
      onAbort();
      throw new DOMException("Cancelled", "AbortError");
    }
    signal?.addEventListener("abort", onAbort, { once: true });

    try {
      await acpClient.prompt(activeSessionId, trimmed);
      if (signal?.aborted) {
        throw new DOMException("Cancelled", "AbortError");
      }
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
      signal?.removeEventListener("abort", onAbort);
      unsub();
    }
  };

  try {
    if (signal?.aborted) {
      throw new DOMException("Cancelled", "AbortError");
    }

    try {
      await runAgainstSession(false);
    } catch (error) {
      if (signal?.aborted || !isAcpConnectionClosedError(error)) {
        throw error;
      }
      // Adapter died — drop the stale id and start a fresh MCP-attached session.
      if (sessionId) {
        useAcpStore.getState().forgetSession(sessionId);
      }
      sessionId = null;
      patchAssistantParts(parts =>
        setAssistantErrorText(parts, "_Reconnecting local Claude/Codex…_"),
      );
      // Clear the reconnect notice before the retry streams real tokens.
      applyMessages(prev =>
        prev.map(m =>
          m.id === assistantId
            ? {
                ...m,
                parts: [{ type: "text", text: "" }] as UIMessage["parts"],
              }
            : m,
        ),
      );
      await runAgainstSession(true);
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

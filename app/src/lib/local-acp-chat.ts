/**
 * Run one main-Chat turn through Local Agent ACP (Claude Code / Codex).
 * Tool calls become `dynamic-tool` UIMessage parts so Chat uses the same
 * StreamingToolCard UI as the in-app agent.
 */
import type { FileUIPart, UIMessage } from "ai";
import { generateObjectId } from "../utils/objectId";
import { acpClient } from "./acp-client";
import { acpSupportsPromptImages } from "./acp-capabilities";
import { fileUiPartsToAcpImages } from "./local-acp-images";
import {
  isLocalAcpModelId,
  localAcpModelIdToProviderId,
  localAcpModelPreference,
  resolveLocalAcpModelValue,
} from "./local-acp-models";
import { sanitizeAcpUserError } from "./acp-user-errors";
import {
  appendAssistantReasoning,
  appendAssistantText,
  getAssistantParts,
  isAcpCodexCommentaryPhase,
  markStreamingReasoningDone,
  setAssistantErrorText,
  upsertAcpToolPart,
  type AcpToolUpdate,
} from "./local-acp-parts";
import { isAcpConnectionClosedError } from "./acp-connection-errors";
import {
  persistLocalAcpChat,
  type LocalAcpChatBinding,
} from "./persist-local-acp-chat";
import { useAcpStore } from "../store/acpStore";
import type { AcpProviderId } from "./acp-types";
import { maybeFocusAppFromAcpTool } from "./acp-app-focus";
import { maybeFocusConsoleFromAcpTool } from "./acp-console-focus";
import { maybeFocusNotebookFromAcpTool } from "./acp-notebook-focus";
import { buildAcpUiContextBlock, getAcpDbtFocus } from "./acp-ui-context";
import {
  buildAcpContinuitySeed,
  prependAcpPromptLayers,
} from "./acp-continuity";

function isAcpModelSwitchError(error: unknown): boolean {
  const msg = error instanceof Error ? error.message : String(error ?? "");
  if (
    /could not switch to model|invalid value for config option model|failed to switch local model/i.test(
      msg,
    )
  ) {
    return true;
  }
  // Bare adapter "Not Found" during model switch — treat as recoverable.
  return /^not found$/i.test(msg.trim()) || /\(Not Found\)/i.test(msg);
}

function modelsEquivalent(
  current: string | null | undefined,
  preferred: string,
  resolved: string,
): boolean {
  if (!current) return false;
  const c = current.toLowerCase();
  const p = preferred.toLowerCase();
  const r = resolved.toLowerCase();
  return (
    c === r ||
    c === p ||
    c.includes(p) ||
    p.includes(c) ||
    r.includes(c) ||
    c.includes(r)
  );
}

/**
 * Returns true when the session is already on the preferred model (no-op),
 * false when the caller should start a fresh session instead of set_config.
 * Codex treats mid-chat model switches as "Conversation interrupted" and
 * dumps prior turns into the next reply — never set_config after the first
 * prompt on that process session.
 */
async function ensureSessionModelOrNeedsFresh(
  sessionId: string,
  modelPreference: string | null | undefined,
): Promise<"ok" | "needs_fresh"> {
  const preferred = modelPreference?.trim();
  if (!preferred) return "ok";
  const store = useAcpStore.getState();
  const session = store.sessions.find(s => s.id === sessionId);
  const providerId = session?.providerId;
  let providerModels = store.status?.providers.find(
    p => p.id === providerId,
  )?.availableModels;
  if (
    providerId &&
    !session?.availableModels?.length &&
    !providerModels?.length
  ) {
    await store.warmProviderModels(providerId);
    providerModels = useAcpStore
      .getState()
      .status?.providers.find(p => p.id === providerId)?.availableModels;
  }
  const resolved = resolveLocalAcpModelValue(
    preferred,
    session?.availableModels?.length ? session.availableModels : providerModels,
  );
  if (modelsEquivalent(session?.currentModel, preferred, resolved)) {
    return "ok";
  }

  // Codex: never hot-swap model on a live chat session.
  if (providerId === "codex") {
    return "needs_fresh";
  }

  // Claude: live switch is usually fine when idle.
  if (session?.busy) {
    return "needs_fresh";
  }
  const updated = await useAcpStore
    .getState()
    .setSessionModel(sessionId, resolved);
  if (!updated) {
    throw new Error(
      useAcpStore.getState().error ||
        `Failed to switch local model to ${resolved}`,
    );
  }
  return "ok";
}

export async function ensureAcpSessionForProvider(
  providerId: AcpProviderId,
  workspaceId?: string,
  preferredSessionId?: string,
  options?: { forceNew?: boolean; model?: string | null },
): Promise<{ sessionId: string; isFresh: boolean }> {
  const store = useAcpStore.getState();
  if (!store.status) {
    await store.refreshStatus();
  }
  let provider = useAcpStore
    .getState()
    .status?.providers.find(p => p.id === providerId);
  if (!provider?.adapterFound) {
    // Local Agent can npm-install the adapter (+ Codex CLI) when the route exists.
    const ensured = await useAcpStore
      .getState()
      .ensureAdapter(providerId, { force: true });
    await useAcpStore.getState().refreshStatus();
    provider = useAcpStore
      .getState()
      .status?.providers.find(p => p.id === providerId);
    if (!provider?.adapterFound) {
      throw new Error(
        ensured?.skipped
          ? `${ensured.message} Or install via Terminal, then retry.`
          : ensured?.message ||
            provider?.installHint ||
            `${providerId} ACP adapter not found. Use Install in Chat or restart Local Agent.`,
      );
    }
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
      const modelState = await ensureSessionModelOrNeedsFresh(
        preferred.id,
        modelPreference,
      );
      if (modelState === "ok") {
        return { sessionId: preferred.id, isFresh: false };
      }
      // Model changed (esp. Codex) — close the old process session and fall
      // through to a fresh one + Chat continuity seed (no mid-chat interrupt).
      useAcpStore.getState().forgetSession(preferred.id);
    }
  }

  // Dead chat binding: do not reuse an unrelated ACP session (wrong memory).
  // Fresh session + Mako transcript seed restores continuity instead.
  // Also skip reuse when the only live session is on a different model and
  // would need a hot-swap (Codex interrupts).
  if (!options?.forceNew && !preferredSessionId) {
    const withMcp = useAcpStore
      .getState()
      .sessions.find(s => s.providerId === providerId && s.makoMcpAttached);
    if (withMcp && liveIds.has(withMcp.id)) {
      useAcpStore.getState().setActiveSession(withMcp.id);
      const modelState = await ensureSessionModelOrNeedsFresh(
        withMcp.id,
        modelPreference,
      );
      if (modelState === "ok") {
        return { sessionId: withMcp.id, isFresh: false };
      }
      useAcpStore.getState().forgetSession(withMcp.id);
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
  return { sessionId: created.id, isFresh: true };
}

export interface LocalAcpChatTurnArgs {
  modelId: string;
  text: string;
  /** Composer image attachments (base64 data URLs) — sent as ACP image blocks. */
  files?: FileUIPart[];
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
    files,
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
  const { images, skipped: skippedAttachments } = fileUiPartsToAcpImages(files);
  if (!trimmed && images.length === 0 && skippedAttachments === 0) return true;

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

  let priorMessages: UIMessage[] = [];
  const userId = generateObjectId();
  const assistantId = generateObjectId();
  applyMessages(prev => {
    priorMessages = prev;
    return [
      ...prev,
      {
        id: userId,
        role: "user",
        // File parts first (same order the cloud transport uses) so the user
        // bubble renders attachment thumbnails above the text.
        parts: [
          ...((files ?? []) as UIMessage["parts"]),
          ...(trimmed ? [{ type: "text" as const, text: trimmed }] : []),
        ],
      },
      {
        id: assistantId,
        role: "assistant",
        // Seed a live Thinking block immediately. Claude ACP (summarized
        // display) often waits seconds with no events, then dumps a short
        // agent_thought_chunk burst right before text — without this seed
        // the UI shows only a spinner during the real think time.
        parts: [{ type: "reasoning", text: "", state: "streaming" }],
      },
    ];
  });

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

  // Checkpoint mid-turn: ACP only used to persist on turn end, so a UI crash
  // (common while focusing apps during app_write_file) wiped everything after
  // the last successful response. Debounced tool checkpoints + final flush.
  let persistTimer: ReturnType<typeof setTimeout> | null = null;
  let persistChain: Promise<void> = Promise.resolve();
  /** Avoid refetching History on every tool checkpoint — only on bind changes. */
  let lastNotifiedSessionId: string | null | undefined = undefined;

  const persistIfPossible = async () => {
    if (!workspaceId || !chatId || !mirrored || mirrored.length === 0) return;
    const binding: LocalAcpChatBinding | undefined = sessionId
      ? { providerId, sessionId, modelId }
      : undefined;
    const snapshot = mirrored;
    const ok = await persistLocalAcpChat({
      workspaceId,
      chatId,
      messages: snapshot,
      localAcp: binding,
    });
    if (!ok) return;
    const sid = binding?.sessionId ?? null;
    if (lastNotifiedSessionId !== sid) {
      lastNotifiedSessionId = sid;
      onPersisted?.(binding);
    }
  };

  const schedulePersist = (mode: "debounce" | "immediate" = "debounce") => {
    if (!workspaceId || !chatId) return;
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    const run = () => {
      persistTimer = null;
      persistChain = persistChain
        .then(() => persistIfPossible())
        .catch(() => undefined);
    };
    if (mode === "immediate") {
      run();
      return;
    }
    persistTimer = setTimeout(run, 750);
  };

  const flushPersist = async () => {
    if (persistTimer) {
      clearTimeout(persistTimer);
      persistTimer = null;
    }
    await persistChain.catch(() => undefined);
    await persistIfPossible();
  };

  // Save user + empty assistant immediately so History survives a crash before
  // the first tool/text token.
  schedulePersist("immediate");

  const modelPreference = localAcpModelPreference(modelId);
  const uiContext = buildAcpUiContextBlock({
    workspaceId,
    chatId,
    modelId,
  });
  const dbtFocus = getAcpDbtFocus();
  const turnGuidance = workspaceId
    ? await useAcpStore
        .getState()
        .fetchTurnGuidance({
          workspaceId,
          userText: trimmed,
          includeDbtRules: dbtFocus.active,
          dbtProjectId: dbtFocus.projectId,
        })
        .catch(() => "")
    : "";

  const runAgainstSession = async (forceNew: boolean) => {
    const ensured = await ensureAcpSessionForProvider(
      providerId,
      workspaceId,
      forceNew ? undefined : preferredSessionId,
      { forceNew, model: modelPreference },
    );
    sessionId = ensured.sessionId;
    // Old Local Agents flatten prompt content to text and silently drop
    // images — fail loudly instead so the user knows the screenshot never
    // reached the model.
    if (
      images.length > 0 &&
      !acpSupportsPromptImages(useAcpStore.getState().status)
    ) {
      throw new Error(
        "This Local Agent build can't send image attachments. " +
          "Update Mako Desktop (or restart the Local Agent), then retry.",
      );
    }
    useAcpStore.getState().ensureEventSubscription(sessionId);
    // Fail closed across turns: a missed end-of-turn revoke (renderer/network
    // interruption) must never carry an old plan grant into this request.
    await useAcpStore.getState().revokeSessionGrant(sessionId);

    const continuitySeed =
      ensured.isFresh && priorMessages.length > 0
        ? buildAcpContinuitySeed(priorMessages)
        : "";
    const promptText = prependAcpPromptLayers({
      userText: trimmed,
      continuitySeed,
      uiContext,
      turnGuidance,
    });

    // Ignore any backlog that still arrives (older Local Agents always replay).
    // Otherwise the previous turn's agent_message chunks paint into this bubble
    // instantly — looks like the model "repeats itself" after you send.
    const ignoreEventsBeforeMs = Date.now();
    const unsub = acpClient.subscribeEvents(
      sessionId,
      event => {
        if (signal?.aborted) return;
        if (
          "at" in event &&
          typeof event.at === "string" &&
          Date.parse(event.at) < ignoreEventsBeforeMs
        ) {
          return;
        }
        if (event.type === "session_update") {
          const update = event.update as AcpToolUpdate & {
            content?: { type?: string; text?: string };
          };
          if (
            update.sessionUpdate === "agent_thought_chunk" &&
            update.content?.type === "text" &&
            typeof update.content.text === "string" &&
            update.content.text
          ) {
            const chunk = update.content.text;
            patchAssistantParts(parts =>
              appendAssistantReasoning(parts, chunk),
            );
          } else if (
            update.sessionUpdate === "agent_message_chunk" &&
            update.content?.type === "text" &&
            typeof update.content.text === "string" &&
            update.content.text
          ) {
            const chunk = update.content.text;
            // Codex puts most "thinking" in commentary-phase message chunks,
            // not agent_thought_chunk (which is often just a short heading).
            if (isAcpCodexCommentaryPhase(update)) {
              patchAssistantParts(parts =>
                appendAssistantReasoning(parts, chunk),
              );
            } else {
              patchAssistantParts(parts => appendAssistantText(parts, chunk));
            }
          } else if (
            update.sessionUpdate === "tool_call" ||
            update.sessionUpdate === "tool_call_update"
          ) {
            patchAssistantParts(parts => upsertAcpToolPart(parts, update));
            // Focus side-effects must not tear down the SSE listener / turn.
            try {
              maybeFocusAppFromAcpTool(workspaceId, update);
              maybeFocusConsoleFromAcpTool(workspaceId, update);
              maybeFocusNotebookFromAcpTool(workspaceId, update);
            } catch {
              // ignore UI focus failures
            }
            // Checkpoint after tools so app-building turns survive a crash.
            schedulePersist(
              update.status === "completed" || update.status === "failed"
                ? "immediate"
                : "debounce",
            );
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
            const cleaned = sanitizeAcpUserError(event.message, {
              providerId,
            });
            if (cleaned) {
              patchAssistantParts(parts =>
                setAssistantErrorText(parts, `Error: ${cleaned}`),
              );
            }
          }
        }
      },
      err => {
        if (signal?.aborted) return;
        if (!isAcpConnectionClosedError(err)) {
          const cleaned = sanitizeAcpUserError(err.message, { providerId });
          if (cleaned) {
            patchAssistantParts(parts =>
              setAssistantErrorText(parts, `(${cleaned})`),
            );
          }
        }
      },
      { replay: false },
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
      // Prompt includes UI context / continuity; transcript keeps raw user text.
      await acpClient.prompt(activeSessionId, promptText, images);
      if (signal?.aborted) {
        throw new DOMException("Cancelled", "AbortError");
      }
      applyMessages(prev => {
        const assistant = prev.find(m => m.id === assistantId);
        let parts = markStreamingReasoningDone(getAssistantParts(assistant));
        // Drop empty reasoning placeholders that never received thought text.
        parts = parts.filter(
          p =>
            !(
              p.type === "reasoning" &&
              !String((p as { text?: string }).text || "").trim()
            ),
        );
        const hasText = parts.some(
          p =>
            p.type === "text" &&
            String((p as { text?: string }).text || "").trim(),
        );
        const hasTool = parts.some(p => p.type === "dynamic-tool");
        const hasReasoning = parts.some(
          p =>
            p.type === "reasoning" &&
            String((p as { text?: string }).text || "").trim(),
        );
        if (!hasText && !hasTool && !hasReasoning) {
          parts = [
            { type: "text", text: "(No response from local agent)" },
          ] as ReturnType<typeof getAssistantParts>;
        }
        return prev.map(m =>
          m.id === assistantId
            ? { ...m, parts: parts as UIMessage["parts"] }
            : m,
        );
      });
    } finally {
      await useAcpStore
        .getState()
        .revokeSessionGrant(activeSessionId)
        .catch(() => undefined);
      signal?.removeEventListener("abort", onAbort);
      unsub();
    }
  };

  try {
    if (signal?.aborted) {
      throw new DOMException("Cancelled", "AbortError");
    }
    if (skippedAttachments > 0) {
      throw new Error(
        "Only image attachments can be sent to local Claude/Codex. " +
          "Remove other file types and try again.",
      );
    }

    try {
      await runAgainstSession(false);
    } catch (error) {
      if (signal?.aborted) throw error;
      const modelSwitch = isAcpModelSwitchError(error);
      if (!isAcpConnectionClosedError(error) && !modelSwitch) {
        throw error;
      }
      // Adapter died or model alias rejected — warm catalog + fresh session.
      if (sessionId) {
        useAcpStore.getState().forgetSession(sessionId);
      }
      sessionId = null;
      if (modelSwitch) {
        await useAcpStore.getState().warmProviderModels(providerId);
      }
      patchAssistantParts(parts =>
        setAssistantErrorText(
          parts,
          modelSwitch
            ? "_Switching local model — starting a fresh session…_"
            : "_Reconnecting local Claude/Codex…_",
        ),
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
      await flushPersist();
      return true;
    }
    let message =
      error instanceof Error ? error.message : "Local ACP prompt failed";
    if (/CODEX_API_KEY|OPENAI_API_KEY/i.test(message)) {
      message =
        "Codex is not signed in. In Settings → Coding Agents click " +
        "Sign in with ChatGPT (runs `codex login`), finish auth in Terminal, " +
        "then retry. Or set OPENAI_API_KEY before starting Desktop.";
    } else if (/^not found$/i.test(message.trim())) {
      message =
        providerId === "codex"
          ? "Codex could not apply that model (or Local Agent is outdated). " +
            "Fully quit/reopen Mako Desktop 0.3.9+, then pick GPT-5.6 Sol/Terra/Luna again."
          : "Claude could not apply that model (or Local Agent is outdated). " +
            "Fully quit/reopen Mako Desktop 0.3.9+, then pick Opus/Sonnet again.";
    }
    // Codex often returns opaque "Internal error" / missing model metadata
    // when the CLI or ACP adapter is outdated. Local Agent auto-updates;
    // force one more ensure from the app if the tip hasn't already.
    if (
      providerId === "codex" &&
      /internal error|model metadata|not found/i.test(message) &&
      !/CODEX_API_KEY|OPENAI_API_KEY|not signed in/i.test(message)
    ) {
      if (!/updated Codex|Mako will try to update/i.test(message)) {
        try {
          const ensured = await useAcpStore
            .getState()
            .ensureAdapter(providerId, { force: true });
          if (ensured?.ok) {
            message =
              `${message}\n\n` +
              "Mako updated Codex on this machine. Send your message again.";
          }
        } catch {
          // keep original
        }
      }
    }
    patchAssistantParts(parts =>
      setAssistantErrorText(parts, `Error: ${message}`),
    );
    await flushPersist();
    throw error;
  }

  await flushPersist();
  return true;
}

import { ObjectId } from "mongodb";
import { randomUUID } from "crypto";
import type { UIMessage } from "ai";
import { SavedConsole } from "../database/workspace-schema";
import {
  chatRepo,
  type ChatLocalAcp,
  type ChatRecord,
  type StoredChatMessage,
  type StoredChatPart,
} from "../repositories/chat";
import type { AgentKind } from "../agent-lib";
import { loggers } from "../logging";
import {
  sanitizeMessagesForPersistence,
  stripToolOutputsForRetry,
  isModelReadyFilePart,
} from "../utils/message-sanitizer";
import {
  dedupeAssistantReasoning,
  dedupeAssistantStreamArtifacts,
} from "../agent-lib/context/compaction";
import { externalizeChatAttachments } from "./chat-attachment.service";

const logger = loggers.agent();

const CONTEXT_WINDOW_SIZE = 10;
const MAX_CONTEXT_LENGTH = 4000;

export interface ThreadContext {
  threadId: string;
  recentMessages: Array<{
    role: "user" | "assistant";
    content: string; // Always present (defaults to empty string for backward compat)
    toolCalls?: Array<{
      toolName: string;
      timestamp?: Date;
      status?: "started" | "completed";
      input?: any;
      result?: any;
    }>;
  }>;
  metadata: { messageCount: number; lastActivityAt: Date };
  activeAgent?: AgentKind;
}

function legacyMessageToStored(msg: {
  id?: string;
  role: "user" | "assistant" | "system";
  parts?: StoredChatPart[];
  content?: string;
  reasoning?: string[];
  toolCalls?: Array<{
    toolCallId?: string;
    toolName: string;
    timestamp?: Date;
    status?: "started" | "completed";
    input?: unknown;
    result?: unknown;
  }>;
}): StoredChatMessage {
  if (Array.isArray(msg.parts) && msg.parts.length > 0) {
    return {
      ...(msg.id !== undefined ? { id: msg.id } : {}),
      role: msg.role,
      parts: msg.parts,
      content: msg.content,
      reasoning: msg.reasoning,
      toolCalls: msg.toolCalls,
    };
  }
  const parts: StoredChatPart[] = [];
  for (const r of msg.reasoning ?? []) {
    parts.push({ type: "reasoning", reasoning: r });
  }
  for (const tc of msg.toolCalls ?? []) {
    parts.push({
      type: `tool-${tc.toolName}`,
      toolCallId: tc.toolCallId ?? "",
      toolName: tc.toolName,
      state: "output-available",
      input: tc.input ?? {},
      ...(tc.result !== undefined ? { output: tc.result } : {}),
    });
  }
  if (
    typeof msg.content === "string" &&
    (msg.content.length > 0 || parts.length === 0)
  ) {
    parts.push({ type: "text", text: msg.content });
  }
  return {
    ...(msg.id !== undefined ? { id: msg.id } : {}),
    role: msg.role,
    parts,
    content: msg.content ?? "",
    ...(msg.reasoning ? { reasoning: msg.reasoning } : {}),
    ...(msg.toolCalls ? { toolCalls: msg.toolCalls } : {}),
  };
}

export const getOrCreateThreadContext = async (
  sessionId: string | undefined,
  workspaceId: string,
  userId?: string,
): Promise<ThreadContext> => {
  if (sessionId) {
    const existingChat = userId
      ? await chatRepo.findOwnedById(workspaceId, sessionId, userId)
      : await chatRepo.findById(sessionId, workspaceId);
    if (existingChat) {
      const messages = existingChat.messages || [];
      const recentMessages = messages.slice(-CONTEXT_WINDOW_SIZE).map(msg => ({
        role: msg.role as "user" | "assistant",
        content: msg.content || "",
        toolCalls: msg.toolCalls,
      }));
      let threadId = existingChat.threadId;
      if (!threadId) {
        threadId = randomUUID();
        await chatRepo.updateThreadFields(sessionId, workspaceId, { threadId });
      }
      return {
        threadId,
        recentMessages,
        metadata: {
          messageCount: messages.length,
          lastActivityAt: existingChat.updatedAt,
        },
        activeAgent: (existingChat.activeAgent ?? undefined) as
          AgentKind | undefined,
      };
    }
  }
  return {
    threadId: randomUUID(),
    recentMessages: [],
    metadata: { messageCount: 0, lastActivityAt: new Date() },
    activeAgent: undefined,
  };
};

export const buildAgentContext = (
  threadContext: ThreadContext,
  newMessage: string,
): string => {
  const contextParts: string[] = [];
  if (threadContext.metadata.messageCount > CONTEXT_WINDOW_SIZE) {
    contextParts.push(
      `[Previous ${threadContext.metadata.messageCount - CONTEXT_WINDOW_SIZE} messages omitted]\n`,
    );
  }
  if (threadContext.recentMessages.length > 0) {
    contextParts.push("Recent conversation:");
    for (const msg of threadContext.recentMessages) {
      const speaker = msg.role === "user" ? "User" : "Assistant";
      contextParts.push(`${speaker}: ${msg.content}`);
    }
    contextParts.push("");
  }
  contextParts.push(`User: ${newMessage}`);
  const fullContext = contextParts.join("\n");
  if (fullContext.length > MAX_CONTEXT_LENGTH) {
    const truncatedContext = fullContext.substring(
      fullContext.length - MAX_CONTEXT_LENGTH,
    );
    return `[Context truncated]\n...${truncatedContext}`;
  }
  return fullContext;
};

export const persistChatSession = async (
  sessionId: string | undefined,
  threadContext: ThreadContext,
  updatedMessages: any[],
  workspaceId: string,
  activeAgent?: AgentKind,
  userId?: string,
  pinnedConsoleId?: string,
): Promise<string> => {
  const now = new Date();
  const storedMessages = updatedMessages.map(legacyMessageToStored);

  if (!sessionId) {
    const newChat = await chatRepo.create({
      workspaceId,
      threadId: threadContext.threadId,
      title: "New Chat",
      messages: storedMessages,
      createdBy: userId ?? null,
      titleGenerated: false,
      createdAt: now,
      updatedAt: now,
      activeAgent:
        (activeAgent as "mongo" | "bigquery" | "triage" | undefined) ?? null,
      pinnedConsoleId: pinnedConsoleId ?? null,
    });
    return newChat.id;
  }

  await chatRepo.updateThreadFields(sessionId, workspaceId, {
    messages: storedMessages,
    updatedAt: now,
    ...(!threadContext.threadId ? { threadId: randomUUID() } : {}),
    ...(activeAgent
      ? { activeAgent: activeAgent as "mongo" | "bigquery" | "triage" }
      : {}),
    ...(pinnedConsoleId !== undefined ? { pinnedConsoleId } : {}),
  });
  return sessionId;
};

export const persistUserMessage = async (
  sessionId: string | undefined,
  threadContext: ThreadContext,
  userMessage: string,
  workspaceId: string,
  userId?: string,
  pinnedConsoleId?: string,
  systemPrompt?: string,
  workspacePrompt?: string,
): Promise<string> => {
  const now = new Date();
  const userMessageObj = legacyMessageToStored({
    role: "user",
    content: userMessage,
  });

  if (!sessionId) {
    const newChat = await chatRepo.create({
      workspaceId,
      threadId: threadContext.threadId,
      title: "New Chat",
      messages: [
        ...threadContext.recentMessages.map(legacyMessageToStored),
        userMessageObj,
      ],
      createdBy: userId ?? null,
      titleGenerated: false,
      createdAt: now,
      updatedAt: now,
      pinnedConsoleId: pinnedConsoleId ?? null,
      systemPrompt: systemPrompt ?? null,
      workspacePrompt: workspacePrompt ?? null,
    });
    return newChat.id;
  }

  const existingChat = await chatRepo.findById(sessionId, workspaceId);
  if (!existingChat) {
    const newChat = await chatRepo.create({
      workspaceId,
      threadId: threadContext.threadId,
      title: "New Chat",
      messages: [userMessageObj],
      createdBy: userId ?? null,
      titleGenerated: false,
      createdAt: now,
      updatedAt: now,
      pinnedConsoleId: pinnedConsoleId ?? null,
      systemPrompt: systemPrompt ?? null,
      workspacePrompt: workspacePrompt ?? null,
    });
    return newChat.id;
  }

  await chatRepo.updateThreadFields(sessionId, workspaceId, {
    messages: [...existingChat.messages, userMessageObj],
    updatedAt: now,
    ...(pinnedConsoleId !== undefined ? { pinnedConsoleId } : {}),
    ...(systemPrompt !== undefined && !existingChat.systemPrompt
      ? { systemPrompt }
      : {}),
    ...(workspacePrompt !== undefined && !existingChat.workspacePrompt
      ? { workspacePrompt }
      : {}),
  });
  return sessionId;
};

export const appendToolCalls = async (
  sessionId: string,
  toolCalls: Array<{
    toolCallId?: string;
    toolName: string;
    timestamp?: Date;
    status?: "started" | "completed";
    input?: unknown;
    result?: unknown;
  }>,
): Promise<void> => {
  if (!toolCalls || toolCalls.length === 0) return;

  const now = new Date();
  const chat = await chatRepo.findById(sessionId);
  if (!chat) return;

  const messages = [...chat.messages];
  const lastMessage = messages[messages.length - 1];
  const newToolParts: StoredChatPart[] = toolCalls.map(tc => ({
    type: `tool-${tc.toolName}`,
    toolCallId: tc.toolCallId ?? "",
    toolName: tc.toolName,
    state: "output-available",
    input: tc.input ?? {},
    ...(tc.result !== undefined ? { output: tc.result } : {}),
  }));

  if (lastMessage && lastMessage.role === "assistant") {
    messages[messages.length - 1] = {
      ...lastMessage,
      parts: [...lastMessage.parts, ...newToolParts],
      toolCalls: [...(lastMessage.toolCalls ?? []), ...toolCalls],
    };
  } else {
    messages.push(
      legacyMessageToStored({
        role: "assistant",
        content: "",
        toolCalls,
      }),
    );
  }

  await chatRepo.updateThreadFields(sessionId, chat.workspaceId, {
    messages,
    updatedAt: now,
  });
};

export const finalizeAssistantMessage = async (
  sessionId: string,
  assistantContent: string,
  activeAgent?: AgentKind,
): Promise<void> => {
  const now = new Date();
  const chat = await chatRepo.findById(sessionId);
  if (!chat) return;

  const messages = [...chat.messages];
  const lastMessage = messages[messages.length - 1];

  if (lastMessage && lastMessage.role === "assistant") {
    const nonTextParts = lastMessage.parts.filter(p => p.type !== "text");
    messages[messages.length - 1] = {
      ...lastMessage,
      parts: [...nonTextParts, { type: "text", text: assistantContent }],
      content: assistantContent,
    };
  } else if (assistantContent.trim()) {
    messages.push(
      legacyMessageToStored({
        role: "assistant",
        content: assistantContent,
      }),
    );
  }

  await chatRepo.updateThreadFields(sessionId, chat.workspaceId, {
    messages,
    updatedAt: now,
    ...(activeAgent
      ? { activeAgent: activeAgent as "mongo" | "bigquery" | "triage" }
      : {}),
  });
};

export const persistChatError = async (
  sessionId: string,
  error: {
    message: string;
    code?: string;
    type?: string;
    stack?: string;
  },
  partialToolCalls?: Array<{
    toolName: string;
    timestamp?: Date;
    status?: "started" | "completed";
    input?: any;
    result?: any;
  }>,
  partialResponse?: string,
): Promise<void> => {
  if (!sessionId) return;

  const now = new Date();

  try {
    const chat = await chatRepo.findById(sessionId);
    if (!chat) return;

    const messages = [...chat.messages];
    const errorDetails = [
      `⚠️ **Error occurred during processing**`,
      ``,
      `**Error:** ${error.message}`,
    ];

    if (error.code) {
      errorDetails.push(`**Code:** ${error.code}`);
    }
    if (error.type) {
      errorDetails.push(`**Type:** ${error.type}`);
    }
    if (partialResponse?.trim()) {
      errorDetails.push(
        ``,
        `**Partial response before error:**`,
        partialResponse.trim(),
      );
    }
    if (partialToolCalls && partialToolCalls.length > 0) {
      errorDetails.push(``, `**Tool calls before error:**`);
      for (const tc of partialToolCalls) {
        const status = tc.status === "completed" ? "✓" : "⏳";
        errorDetails.push(`- ${status} ${tc.toolName}`);
      }
    }
    errorDetails.push(``, `*Occurred at: ${now.toISOString()}*`);

    const errorToolCalls = [
      ...(partialToolCalls ?? []),
      {
        toolName: "_error",
        timestamp: now,
        status: "completed" as const,
        result: {
          error: error.message,
          code: error.code,
          type: error.type,
        },
      },
    ];

    messages.push(
      legacyMessageToStored({
        role: "assistant",
        content: errorDetails.join("\n"),
        toolCalls: errorToolCalls,
      }),
    );

    await chatRepo.updateThreadFields(sessionId, chat.workspaceId, {
      messages,
      updatedAt: now,
    });
  } catch (persistError) {
    logger.error("Failed to persist chat error", {
      sessionId,
      error: persistError,
    });
  }
};

/**
 * Convert UIMessage to stored format.
 * The `parts` array is the source of truth for message structure;
 * legacy fields (`content`, `reasoning`, `toolCalls`) are kept for compatibility.
 */
export function convertUIMessageToStoredFormat(msg: UIMessage): {
  id: string;
  role: "user" | "assistant";
  parts: Array<StoredChatPart>;
  metadata?: Record<string, unknown>;
  content: string;
  reasoning?: string[];
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    input?: unknown;
    result?: unknown;
  }>;
} {
  const storedParts: StoredChatPart[] = (msg.parts || [])
    .map((part): StoredChatPart | null => {
      const p = part as Record<string, unknown>;
      const partType = p.type as string;

      if (partType === "text") {
        const providerMetadata = p.providerMetadata;
        return {
          type: "text",
          text: p.text as string,
          ...(providerMetadata != null ? { providerMetadata } : {}),
        };
      }

      if (partType === "reasoning") {
        const providerMetadata = p.providerMetadata;
        return {
          type: "reasoning",
          reasoning:
            (p.reasoning as string | undefined) ??
            (p.text as string | undefined) ??
            "",
          ...(providerMetadata != null ? { providerMetadata } : {}),
        };
      }

      if (partType === "file") {
        if (!isModelReadyFilePart(p)) {
          return null;
        }
        return {
          type: "file",
          url: p.url as string,
          mediaType: p.mediaType as string,
          ...(p.filename !== undefined
            ? { filename: p.filename as string }
            : {}),
        };
      }

      if (partType.startsWith("tool-") || partType === "dynamic-tool") {
        const toolName =
          partType === "dynamic-tool"
            ? (p.toolName as string)
            : partType.split("-").slice(1).join("-");
        const hasOutput =
          Object.prototype.hasOwnProperty.call(p, "output") &&
          p.output !== undefined;
        return {
          type: partType,
          toolCallId: p.toolCallId as string,
          toolName: toolName || (p.toolName as string),
          input: p.input ?? {},
          state: (p.state as string) || "output-available",
          ...(hasOutput ? { output: p.output } : {}),
          ...(p.approval != null ? { approval: p.approval } : {}),
          ...(p.errorText != null ? { errorText: p.errorText as string } : {}),
          ...(p.rawInput != null ? { rawInput: p.rawInput } : {}),
          ...(p.providerExecuted != null
            ? { providerExecuted: p.providerExecuted as boolean }
            : {}),
          ...(p.preliminary != null
            ? { preliminary: p.preliminary as boolean }
            : {}),
          ...(p.callProviderMetadata != null
            ? { callProviderMetadata: p.callProviderMetadata }
            : {}),
          ...(p.resultProviderMetadata != null
            ? { resultProviderMetadata: p.resultProviderMetadata }
            : {}),
          ...(p.toolMetadata != null ? { toolMetadata: p.toolMetadata } : {}),
          ...(p.title != null ? { title: p.title as string } : {}),
        };
      }

      // Unknown / step-start / source-url / data-* / Local ACP custom parts
      return { ...p, type: partType };
    })
    .filter((part): part is StoredChatPart => part !== null);

  const textContent = (msg.parts || [])
    .filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" && "text" in p,
    )
    .map(p => p.text)
    .join("");

  const reasoningParts = (msg.parts || [])
    .filter(
      (p): p is { type: "reasoning"; text: string } =>
        p.type === "reasoning" && "text" in p,
    )
    .map(p => p.text);

  const toolCalls = (msg.parts || [])
    .filter(p => {
      const type = p.type;
      if (typeof type !== "string") return false;
      return type.startsWith("tool-") || type === "dynamic-tool";
    })
    .map(p => {
      const part = p as Record<string, unknown>;
      const partType = part.type as string;
      const toolName =
        partType === "dynamic-tool"
          ? (part.toolName as string)
          : partType.split("-").slice(1).join("-");
      return {
        toolCallId: (part.toolCallId as string) || "",
        toolName: toolName || "",
        input: part.input ?? {},
        result: part.output ?? null,
      };
    })
    .filter(tc => tc.toolName.length > 0);

  const metadata = (msg as { metadata?: Record<string, unknown> }).metadata;

  return {
    id: msg.id,
    role: msg.role as "user" | "assistant",
    parts: storedParts,
    ...(metadata != null ? { metadata } : {}),
    content: textContent || "",
    reasoning: reasoningParts.length > 0 ? reasoningParts : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

export interface ChatUsageData {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  reasoningTokens?: number;
  costUsd?: number;
  model?: string;
}

/**
 * Save chat using AI SDK best practice: single atomic save at the end.
 * Delegates through `chatRepo.saveMessages` (workspace-scoped dual-run).
 * `stripToolOutputsForRetry` is strictly on the Mongo write path (PG has no 16MB BSON cap).
 */
export const saveChat = async (
  chatId: string,
  workspaceId: string,
  userId: string,
  messages: UIMessage[],
  usage?: ChatUsageData,
  options?: { localAcp?: ChatLocalAcp | null },
): Promise<ChatRecord | null> => {
  const now = new Date();

  let messagesToPersist = sanitizeMessagesForPersistence(messages);
  try {
    messagesToPersist = await externalizeChatAttachments(messagesToPersist, {
      workspaceId,
      chatId,
      userId,
    });
  } catch (error) {
    logger.error("Failed to externalize chat attachments; saving inline", {
      error,
      chatId,
    });
  }

  const persistableMessages = messagesToPersist.filter(
    m => m.role !== "assistant" || (m.parts && m.parts.length > 0),
  );
  if (persistableMessages.length !== messages.length) {
    logger.warn("Dropping empty assistant messages before persistence", {
      chatId,
      dropped: messages.length - persistableMessages.length,
    });
  }

  const reasoningDedupe = dedupeAssistantReasoning(persistableMessages);
  if (reasoningDedupe.changed) {
    logger.warn("Removed duplicate reasoning parts before persistence", {
      chatId,
      removedCount: reasoningDedupe.removedCount,
    });
  }

  const artifactDedupe = dedupeAssistantStreamArtifacts(
    reasoningDedupe.messages,
  );
  if (artifactDedupe.changed) {
    logger.warn("Removed replayed text/step-start parts before persistence", {
      chatId,
      removedCount: artifactDedupe.removedCount,
    });
  }

  const storedMessages: StoredChatMessage[] = artifactDedupe.messages.map(
    convertUIMessageToStoredFormat,
  );
  const mongoBsonRetryMessages: StoredChatMessage[] = stripToolOutputsForRetry(
    artifactDedupe.messages,
  ).map(convertUIMessageToStoredFormat);

  const assistantMessageCount = persistableMessages.filter(
    m => m.role === "assistant",
  ).length;

  return chatRepo.saveMessages({
    chatId,
    workspaceId,
    userId,
    messages: storedMessages,
    mongoBsonRetryMessages,
    usage:
      usage && usage.totalTokens > 0
        ? {
            assistantMessageIndex: assistantMessageCount - 1,
            promptTokens: usage.promptTokens,
            completionTokens: usage.completionTokens,
            totalTokens: usage.totalTokens,
            cacheReadTokens: usage.cacheReadTokens,
            cacheWriteTokens: usage.cacheWriteTokens,
            reasoningTokens: usage.reasoningTokens,
            costUsd: usage.costUsd,
            model: usage.model,
          }
        : undefined,
    localAcp: options?.localAcp,
    now,
  });
};

/**
 * Get consoles by their IDs.
 * Used to restore consoles when loading a chat (IDs are extracted from modify_console tool calls).
 * NOTE: `SavedConsole` usage is intentionally left untouched for Phase 2A integration.
 */
export const getConsolesByIds = async (
  consoleIds: string[],
): Promise<
  Array<{
    id: string;
    title: string;
    content: string;
    connectionId?: string;
    databaseId?: string;
    databaseName?: string;
  }>
> => {
  if (!consoleIds.length) return [];

  const validIds = consoleIds
    .filter(id => ObjectId.isValid(id))
    .map(id => new ObjectId(id));

  if (!validIds.length) return [];

  const consoles = await SavedConsole.find({
    _id: { $in: validIds },
  });

  return consoles.map(c => ({
    id: c._id.toString(),
    title: c.name,
    content: c.code,
    connectionId: c.connectionId?.toString(),
    databaseId: c.databaseId,
    databaseName: c.databaseName,
  }));
};

/**
 * Mid-turn checkpoint (§13.27): persist the in-progress assistant message so
 * a process death mid-turn costs seconds, not the turn.
 */
export const saveTurnCheckpoint = async (
  chatId: string,
  streamId: string,
  message: UIMessage,
  workspaceId?: string,
): Promise<void> => {
  try {
    const [sanitized] = sanitizeMessagesForPersistence([message]);
    await chatRepo.saveTurnCheckpoint(
      workspaceId,
      chatId,
      streamId,
      convertUIMessageToStoredFormat(sanitized),
    );
  } catch (error) {
    logger.warn("Turn checkpoint write failed", {
      chatId,
      error: error instanceof Error ? error.message : String(error),
    });
  }
};

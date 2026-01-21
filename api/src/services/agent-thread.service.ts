import { ObjectId } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import type { UIMessage } from "ai";
import { Chat, SavedConsole } from "../database/workspace-schema";
import type { AgentKind } from "../agent-v2";

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

export const getOrCreateThreadContext = async (
  sessionId: string | undefined,
  workspaceId: string,
  userId?: string,
): Promise<ThreadContext> => {
  if (sessionId) {
    const query: any = {
      _id: new ObjectId(sessionId),
      workspaceId: new ObjectId(workspaceId),
    };
    // Add user filter if userId is provided
    if (userId) {
      query.createdBy = userId;
    }

    const existingChat = await Chat.findOne(query);
    if (existingChat) {
      const messages = existingChat.messages || [];
      // Map messages to ensure content is always a string (backward compat)
      const recentMessages = messages.slice(-CONTEXT_WINDOW_SIZE).map(msg => ({
        role: msg.role,
        content: msg.content || "", // Default to empty string if not present
        toolCalls: msg.toolCalls,
      }));
      let threadId = existingChat.threadId;
      if (!threadId) {
        threadId = uuidv4();
        await Chat.findByIdAndUpdate(sessionId, { threadId });
      }
      return {
        threadId,
        recentMessages,
        metadata: {
          messageCount: messages.length,
          lastActivityAt: existingChat.updatedAt,
        },
        activeAgent: (existingChat as any).activeAgent,
      };
    }
  }
  return {
    threadId: uuidv4(),
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
  if (!sessionId) {
    const newChat = new Chat({
      workspaceId: new ObjectId(workspaceId),
      threadId: threadContext.threadId,
      title: "New Chat",
      messages: updatedMessages,
      createdBy: userId || "system",
      titleGenerated: false,
      createdAt: now,
      updatedAt: now,
      activeAgent,
      pinnedConsoleId,
    });
    await newChat.save();
    return newChat._id.toString();
  }
  const updateData: any = { messages: updatedMessages, updatedAt: now };
  if (!threadContext.threadId) {
    updateData.threadId = uuidv4();
  }
  if (activeAgent) {
    updateData.activeAgent = activeAgent;
  }
  if (pinnedConsoleId !== undefined) {
    updateData.pinnedConsoleId = pinnedConsoleId;
  }
  await Chat.findByIdAndUpdate(sessionId, updateData, { new: true });
  return sessionId;
};

/**
 * Persist user message immediately to create/update chat session before agent runs.
 * This ensures the user's message is saved even if the agent crashes.
 */
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
  const userMessageObj = { role: "user" as const, content: userMessage };

  if (!sessionId) {
    // Create new chat with just the user message
    const newChat = new Chat({
      workspaceId: new ObjectId(workspaceId),
      threadId: threadContext.threadId,
      title: "New Chat",
      messages: [...threadContext.recentMessages, userMessageObj],
      createdBy: userId || "system",
      titleGenerated: false,
      createdAt: now,
      updatedAt: now,
      pinnedConsoleId,
      systemPrompt,
      workspacePrompt,
    });
    await newChat.save();
    return newChat._id.toString();
  }

  // Update existing chat with the new user message
  // IMPORTANT: Fetch current messages from DB to avoid truncation data loss
  // (threadContext.recentMessages only contains last CONTEXT_WINDOW_SIZE messages)
  const existingChat = await Chat.findById(sessionId);
  if (!existingChat) {
    // Chat was deleted between context load and persist - create new one
    const newChat = new Chat({
      workspaceId: new ObjectId(workspaceId),
      threadId: threadContext.threadId,
      title: "New Chat",
      messages: [userMessageObj],
      createdBy: userId || "system",
      titleGenerated: false,
      createdAt: now,
      updatedAt: now,
      pinnedConsoleId,
      systemPrompt,
      workspacePrompt,
    });
    await newChat.save();
    return newChat._id.toString();
  }

  const existingMessages = existingChat.messages || [];
  const updateData: Record<string, unknown> = {
    messages: [...existingMessages, userMessageObj],
    updatedAt: now,
  };
  if (pinnedConsoleId !== undefined) {
    updateData.pinnedConsoleId = pinnedConsoleId;
  }
  // Update prompts if provided (only on first message of a new session or if they changed)
  if (systemPrompt !== undefined && !existingChat.systemPrompt) {
    updateData.systemPrompt = systemPrompt;
  }
  if (workspacePrompt !== undefined && !existingChat.workspacePrompt) {
    updateData.workspacePrompt = workspacePrompt;
  }
  await Chat.findByIdAndUpdate(sessionId, updateData, { new: true });
  return sessionId;
};

/**
 * Append tool calls incrementally to the current assistant message.
 * Creates an assistant message if one doesn't exist after the last user message.
 * Called during streaming as tool calls complete.
 */
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
  const chat = await Chat.findById(sessionId);
  if (!chat) return;

  const messages = [...(chat.messages || [])];
  const lastMessage = messages[messages.length - 1];

  if (lastMessage && lastMessage.role === "assistant") {
    // Append to existing assistant message
    const existingToolCalls = lastMessage.toolCalls || [];
    lastMessage.toolCalls = [...existingToolCalls, ...toolCalls];
  } else {
    // Create new assistant message with tool calls (content will be updated later)
    messages.push({
      role: "assistant" as const,
      content: "", // Placeholder - will be updated in finalizeAssistantMessage
      toolCalls,
    });
  }

  await Chat.findByIdAndUpdate(
    sessionId,
    { messages, updatedAt: now },
    { new: true },
  );
};

/**
 * Finalize the assistant message with the final text content.
 * Called after streaming completes.
 */
export const finalizeAssistantMessage = async (
  sessionId: string,
  assistantContent: string,
  activeAgent?: AgentKind,
): Promise<void> => {
  const now = new Date();
  const chat = await Chat.findById(sessionId);
  if (!chat) return;

  const messages = [...(chat.messages || [])];
  const lastMessage = messages[messages.length - 1];

  if (lastMessage && lastMessage.role === "assistant") {
    // Update existing assistant message with final content
    lastMessage.content = assistantContent;
  } else if (assistantContent.trim()) {
    // No assistant message exists yet (no tool calls were made) - create one
    messages.push({
      role: "assistant" as const,
      content: assistantContent,
    });
  }

  const updateData: {
    messages: typeof messages;
    updatedAt: Date;
    activeAgent?: AgentKind;
  } = {
    messages,
    updatedAt: now,
  };
  if (activeAgent) {
    updateData.activeAgent = activeAgent;
  }

  await Chat.findByIdAndUpdate(sessionId, updateData, { new: true });
};

/**
 * Update chat with assistant response and tool calls.
 * Called after agent completes (or partially completes).
 * @deprecated Use appendToolCalls + finalizeAssistantMessage for incremental persistence
 */
export const updateChatWithResponse = async (
  sessionId: string,
  assistantContent: string,
  toolCalls?: Array<{
    toolName: string;
    timestamp?: Date;
    status?: "started" | "completed";
    input?: unknown;
    result?: unknown;
  }>,
  activeAgent?: AgentKind,
): Promise<void> => {
  const now = new Date();

  // Fetch current messages and append assistant response
  const chat = await Chat.findById(sessionId);
  if (!chat) return;

  const messages = [...(chat.messages || [])];

  // Add assistant message if there's content OR tool calls
  // Tool calls should be persisted even when the assistant doesn't generate text
  const hasContent = assistantContent.trim();
  const hasToolCalls = toolCalls && toolCalls.length > 0;

  if (hasContent || hasToolCalls) {
    messages.push({
      role: "assistant" as const,
      content: assistantContent,
      toolCalls: hasToolCalls ? toolCalls : undefined,
    });
  }

  const updateData: {
    messages: typeof messages;
    updatedAt: Date;
    activeAgent?: AgentKind;
  } = {
    messages,
    updatedAt: now,
  };
  if (activeAgent) {
    updateData.activeAgent = activeAgent;
  }

  await Chat.findByIdAndUpdate(sessionId, updateData, { new: true });
};

/**
 * Persist error information to the chat for debugging.
 * Adds an assistant message with error details and any partial tool calls.
 */
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
    const chat = await Chat.findById(sessionId);
    if (!chat) return;

    const messages = [...(chat.messages || [])];

    // Create error details for debugging
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

    // Add partial response if any
    if (partialResponse?.trim()) {
      errorDetails.push(
        ``,
        `**Partial response before error:**`,
        partialResponse.trim(),
      );
    }

    // Add tool call summary if any
    if (partialToolCalls && partialToolCalls.length > 0) {
      errorDetails.push(``, `**Tool calls before error:**`);
      for (const tc of partialToolCalls) {
        const status = tc.status === "completed" ? "✓" : "⏳";
        errorDetails.push(`- ${status} ${tc.toolName}`);
      }
    }

    // Add timestamp
    errorDetails.push(``, `*Occurred at: ${now.toISOString()}*`);

    // Add as an assistant message with error marker
    messages.push({
      role: "assistant" as const,
      content: errorDetails.join("\n"),
      toolCalls:
        partialToolCalls && partialToolCalls.length > 0
          ? [
              ...partialToolCalls,
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
            ]
          : [
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
            ],
    });

    await Chat.findByIdAndUpdate(
      sessionId,
      { messages, updatedAt: now },
      { new: true },
    );
  } catch (persistError) {
    // Don't throw - this is best-effort error logging
    console.error("Failed to persist chat error:", persistError);
  }
};

/**
 * Convert UIMessage to stored format.
 * UIMessage (AI SDK v6) uses parts array - we now store parts directly to preserve order.
 *
 * NEW: The `parts` array is the source of truth for message structure.
 * Legacy fields (content, reasoning, toolCalls) are still populated for backward compatibility.
 */
function convertUIMessageToStoredFormat(msg: UIMessage): {
  id: string;
  role: "user" | "assistant";
  parts: Array<{
    type: string;
    text?: string;
    reasoning?: string;
    toolCallId?: string;
    toolName?: string;
    input?: unknown;
    output?: unknown;
    state?: string;
  }>;
  // Legacy fields for backward compatibility
  content: string;
  reasoning?: string[];
  toolCalls?: Array<{
    toolCallId: string;
    toolName: string;
    input?: unknown;
    result?: unknown;
  }>;
} {
  // NEW: Store raw parts array - this preserves chronological order
  const storedParts = (msg.parts || []).map(part => {
    const p = part as Record<string, unknown>;
    const partType = p.type as string;

    if (partType === "text") {
      return { type: "text", text: p.text as string };
    }

    if (partType === "reasoning") {
      // Reasoning parts may have text in 'text' or 'reasoning' field
      return {
        type: "reasoning",
        reasoning: (p.reasoning as string) || (p.text as string),
      };
    }

    // Tool parts: type is "tool-{toolName}" or "dynamic-tool"
    if (partType.startsWith("tool-") || partType === "dynamic-tool") {
      const toolName =
        partType === "dynamic-tool"
          ? (p.toolName as string)
          : partType.split("-").slice(1).join("-");
      return {
        type: partType,
        toolCallId: p.toolCallId as string,
        toolName: toolName || (p.toolName as string),
        input: p.input ?? {},
        output: p.output ?? null,
        state: (p.state as string) || "output-available",
      };
    }

    // Unknown part type - store as-is
    return { type: partType, ...p };
  });

  // TODO: Remove legacy field extraction once we're OK with losing backward compatibility
  // for old consumers that read content/reasoning/toolCalls instead of parts.
  // LEGACY: Extract text content from parts (excluding reasoning)
  const textContent = (msg.parts || [])
    .filter(
      (p): p is { type: "text"; text: string } =>
        p.type === "text" && "text" in p,
    )
    .map(p => p.text)
    .join("");

  // LEGACY: Extract reasoning/thinking parts separately (AI SDK v6 best practice)
  // These are emitted by models like Claude with extended thinking or DeepSeek
  const reasoningParts = (msg.parts || [])
    .filter(
      (p): p is { type: "reasoning"; text: string } =>
        p.type === "reasoning" && "text" in p,
    )
    .map(p => p.text);

  // LEGACY: Extract tool calls from parts
  // AI SDK v6 has two tool part types:
  // - Static tools: type is "tool-{toolName}" (e.g., "tool-list_connections")
  // - Dynamic tools: type is "dynamic-tool" with toolName as separate property
  const toolCalls = (msg.parts || [])
    .filter(p => {
      const type = p.type;
      if (typeof type !== "string") return false;
      // Match static tools (type starts with "tool-") or dynamic tools (type === "dynamic-tool")
      return type.startsWith("tool-") || type === "dynamic-tool";
    })
    .map(p => {
      const part = p as Record<string, unknown>;
      const partType = part.type as string;
      // For dynamic tools, use the toolName property; for static tools, extract from type
      // Static tool names: "tool-{name}" -> split on "-" and rejoin (handles names with hyphens)
      const toolName =
        partType === "dynamic-tool"
          ? (part.toolName as string)
          : partType.split("-").slice(1).join("-");
      return {
        toolCallId: (part.toolCallId as string) || "",
        toolName: toolName || "",
        // IMPORTANT: input must never be undefined - OpenAI API requires 'arguments' when reloading
        input: part.input ?? {},
        result: part.output ?? null,
      };
    })
    // Filter out tool calls without valid toolName
    .filter(tc => tc.toolName.length > 0);

  return {
    id: msg.id,
    role: msg.role as "user" | "assistant",
    // NEW: Source of truth - preserves chronological order
    parts: storedParts,
    // LEGACY: Keep for backward compatibility
    content: textContent || "",
    reasoning: reasoningParts.length > 0 ? reasoningParts : undefined,
    toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
  };
}

/**
 * Usage data for token tracking (for metered billing)
 */
export interface ChatUsageData {
  promptTokens: number;
  completionTokens: number;
  totalTokens: number;
  model?: string;
}

/**
 * Save chat using AI SDK best practice: single atomic save at the end.
 * Uses upsert to create or update the chat document.
 *
 * chatId must be a valid 24-character MongoDB ObjectId hex string.
 * The frontend generates this using generateObjectId() utility.
 *
 * @param usage - Optional usage data from AI SDK for token tracking
 */
export const saveChat = async (
  chatId: string,
  workspaceId: string,
  userId: string,
  messages: UIMessage[],
  usage?: ChatUsageData,
): Promise<typeof Chat.prototype | null> => {
  const now = new Date();
  const storedMessages = messages.map(convertUIMessageToStoredFormat);

  // Count assistant messages to determine the message index for usage history
  const assistantMessageCount = messages.filter(
    m => m.role === "assistant",
  ).length;

  // Build the update operation
  const updateOp: Record<string, unknown> = {
    $set: {
      messages: storedMessages,
      updatedAt: now,
    },
    $setOnInsert: {
      workspaceId: new ObjectId(workspaceId),
      createdBy: userId,
      title: "New Chat",
      titleGenerated: false,
      threadId: uuidv4(),
      createdAt: now,
    },
  };

  // If usage data is provided, update cumulative totals and append to history
  if (usage && usage.totalTokens > 0) {
    // Use $inc for cumulative totals to handle concurrent updates correctly
    (updateOp as Record<string, Record<string, unknown>>).$inc = {
      "usage.promptTokens": usage.promptTokens,
      "usage.completionTokens": usage.completionTokens,
      "usage.totalTokens": usage.totalTokens,
    };

    // Append to usage history for per-turn tracking
    (updateOp as Record<string, Record<string, unknown>>).$push = {
      "usage.history": {
        messageIndex: assistantMessageCount - 1, // 0-indexed
        promptTokens: usage.promptTokens,
        completionTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        model: usage.model,
        timestamp: now,
      },
    };
  }

  const result = await Chat.findOneAndUpdate(
    { _id: new ObjectId(chatId) },
    updateOp,
    { upsert: true, new: true },
  );

  return result;
};

/**
 * Get consoles by their IDs.
 * Used to restore consoles when loading a chat (IDs are extracted from modify_console tool calls).
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

import { ObjectId } from "mongodb";
import { v4 as uuidv4 } from "uuid";
import { Chat } from "../database/workspace-schema";
import { AgentKind } from "../agent/types";

const CONTEXT_WINDOW_SIZE = 10;
const MAX_CONTEXT_LENGTH = 4000;

export interface ThreadContext {
  threadId: string;
  recentMessages: Array<{
    role: "user" | "assistant";
    content: string;
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
      const recentMessages = messages.slice(-CONTEXT_WINDOW_SIZE);
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
    });
    await newChat.save();
    return newChat._id.toString();
  }

  const existingMessages = existingChat.messages || [];
  const updateData: any = {
    messages: [...existingMessages, userMessageObj],
    updatedAt: now,
  };
  if (pinnedConsoleId !== undefined) {
    updateData.pinnedConsoleId = pinnedConsoleId;
  }
  await Chat.findByIdAndUpdate(sessionId, updateData, { new: true });
  return sessionId;
};

/**
 * Update chat with assistant response and tool calls.
 * Called after agent completes (or partially completes).
 */
export const updateChatWithResponse = async (
  sessionId: string,
  assistantContent: string,
  toolCalls?: Array<{
    toolName: string;
    timestamp?: Date;
    status?: "started" | "completed";
    input?: any;
    result?: any;
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

  const updateData: any = { messages, updatedAt: now };
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

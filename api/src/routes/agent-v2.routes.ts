/**
 * Agent V2 Routes
 * Using Vercel AI SDK for improved streaming and tool handling
 */

import { Hono } from "hono";
import { ObjectId } from "mongodb";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import {
  streamAgentResponse,
  processToolResult,
  getAvailableModels,
} from "../agent-v2";
import type { ConsoleDataV2, AgentKind } from "../agent-v2/types";
import {
  getOrCreateThreadContext,
  persistUserMessage,
  updateChatWithResponse,
  persistChatError,
} from "../services/agent-thread.service";
import {
  Chat,
  DatabaseConnection,
  Workspace,
} from "../database/workspace-schema";
import {
  shouldGenerateTitle,
  generateChatTitle,
} from "../services/title-generator";
import { selectInitialAgent } from "../services/agent-selection.service";

export const agentV2Routes = new Hono();

// Apply unified auth middleware to all routes
agentV2Routes.use("*", unifiedAuthMiddleware);

/**
 * GET /models - List available AI models based on configured API keys
 */
agentV2Routes.get("/models", async (c: AuthenticatedContext) => {
  const models = getAvailableModels();
  return c.json({ models });
});

agentV2Routes.post("/stream", async (c: AuthenticatedContext) => {
  const user = c.get("user");
  const userId = user?.id;

  if (!userId) {
    return c.json({ error: "User not authenticated" }, 401);
  }

  let body: Record<string, unknown> = {};
  try {
    body = await c.req.json();
  } catch (e) {
    console.error("[Agent V2] Error parsing request body", e);
  }

  const { message, sessionId, workspaceId, consoles, consoleId, modelId } =
    body as {
      message?: string;
      sessionId?: string;
      workspaceId?: string;
      consoles?: ConsoleDataV2[];
      consoleId?: string;
      modelId?: string;
    };

  if (!message || typeof message !== "string" || message.trim().length === 0) {
    return c.json({ error: "'message' is required" }, 400);
  }

  if (!workspaceId || !ObjectId.isValid(workspaceId)) {
    return c.json(
      { error: "'workspaceId' is required and must be valid" },
      400,
    );
  }

  // Get or create thread context
  const threadContext = await getOrCreateThreadContext(
    sessionId,
    workspaceId,
    userId.toString(),
  );

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let isClosed = false;
      let currentSessionId = sessionId;
      let assistantReply = "";
      let errorPersisted = false;
      const toolCalls: Array<{
        toolCallId?: string;
        toolName: string;
        timestamp: Date;
        status: "started" | "completed";
        input?: unknown;
        result?: unknown;
      }> = [];

      const sendEvent = (data: unknown) => {
        if (isClosed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
          );
        } catch (e) {
          console.error("[Agent V2] Failed to send event:", e);
        }
      };

      try {
        // Get existing session if available
        const pinned = sessionId
          ? await Chat.findOne({
              _id: new ObjectId(sessionId),
              workspaceId: new ObjectId(workspaceId),
              createdBy: userId.toString(),
            })
          : null;

        // Early persistence: Save user message immediately
        currentSessionId = await persistUserMessage(
          sessionId,
          threadContext,
          message.trim(),
          workspaceId,
          userId.toString(),
          consoleId,
        );

        // Send the session ID immediately
        sendEvent({ type: "session", sessionId: currentSessionId });

        // Get workspace database capabilities
        const workspaceDatabases = await DatabaseConnection.find({
          workspaceId: new ObjectId(workspaceId),
        }).select({ type: 1, name: 1 });

        const databaseTypeMap = new Map<string, string>();
        workspaceDatabases.forEach(db => {
          databaseTypeMap.set(db._id.toString(), db.type);
        });

        // Enrich consoles with connection type information
        const enrichedConsoles: ConsoleDataV2[] = (consoles || []).map(
          (c: ConsoleDataV2) => ({
            ...c,
            connectionType:
              c.connectionType ||
              (c.connectionId
                ? databaseTypeMap.get(c.connectionId)
                : undefined),
          }),
        );

        // Use pinned console ID if available
        const effectiveConsoleId =
          consoleId ||
          (pinned as { pinnedConsoleId?: string } | null)?.pinnedConsoleId;

        // Workspace custom prompt (from Settings) - appended to system prompt for context
        const workspace = await Workspace.findById(workspaceId).select({
          settings: 1,
        });
        const workspaceCustomPrompt = workspace?.settings?.customPrompt;

        // Detect agent type based on context
        const workspaceHasMongoDB = workspaceDatabases.some(
          db => db.type === "mongodb",
        );
        const workspaceHasBigQuery = workspaceDatabases.some(
          db => db.type === "bigquery",
        );
        const workspaceHasPostgres = workspaceDatabases.some(
          db => db.type === "postgresql" || db.type === "cloudsql-postgres",
        );

        const sessionActiveAgent = (
          pinned as { activeAgent?: AgentKind } | null
        )?.activeAgent;
        const selectedAgent = selectInitialAgent({
          sessionActiveAgent,
          userMessage: message,
          consoles: enrichedConsoles,
          workspaceHasMongoDB,
          workspaceHasBigQuery,
          workspaceHasPostgres,
        });

        // Universal v2: always run the universal agent (single prompt + unified tools).
        // We use selectedAgent for the UI display mode (legacy compatibility).
        const uiAgentMode: AgentKind = selectedAgent;

        console.log(
          `[Agent V2] Using universal agent (UI mode: ${uiAgentMode})`,
        );

        // Send agent mode event (legacy modes for UI compatibility)
        sendEvent({ type: "agent_mode", mode: uiAgentMode });

        // Stream the response using Vercel AI SDK with proper conversation history
        const result = await streamAgentResponse({
          conversationHistory: threadContext.recentMessages,
          newMessage: message.trim(),
          workspaceId,
          consoles: enrichedConsoles,
          consoleId: effectiveConsoleId,
          sessionId: currentSessionId,
          modelId,
          workspaceCustomPrompt,
        });

        // Process the stream
        for await (const chunk of result.fullStream) {
          if (chunk.type === "text-delta") {
            // AI SDK v5 uses 'text' instead of 'textDelta'
            const textContent = (chunk as { text?: string }).text ?? "";
            assistantReply += textContent;
            sendEvent({ type: "text", content: textContent });
          } else if (chunk.type === "tool-call") {
            const toolName = chunk.toolName;
            const toolCallId = (chunk as { toolCallId?: string }).toolCallId;
            console.log(`[Agent V2] Tool called: ${toolName}`);

            // AI SDK v5 uses 'input' instead of 'args'
            const toolInput = (chunk as { input?: unknown }).input;

            sendEvent({
              type: "step",
              name: `tool_called:${toolName}`,
              toolCallId,
              status: "started",
              input: toolInput,
            });

            toolCalls.push({
              toolCallId,
              toolName,
              timestamp: new Date(),
              status: "started",
              input: toolInput,
            });
          } else if (chunk.type === "tool-result") {
            const toolName = chunk.toolName;
            const toolCallId = (chunk as { toolCallId?: string }).toolCallId;
            // AI SDK v5 uses 'output' instead of 'result'
            const toolResult = (chunk as { output?: unknown }).output;

            console.log(`[Agent V2] Tool result for ${toolName}`);

            // Update tool call status
            const lastToolCall = toolCallId
              ? toolCalls.find(
                  tc => tc.toolCallId === toolCallId && tc.status === "started",
                )
              : toolCalls
                  .filter(
                    tc => tc.toolName === toolName && tc.status === "started",
                  )
                  .pop();

            if (lastToolCall) {
              lastToolCall.status = "completed";
              lastToolCall.result = toolResult;
            } else {
              toolCalls.push({
                toolCallId,
                toolName,
                timestamp: new Date(),
                status: "completed",
                result: toolResult,
              });
            }

            sendEvent({
              type: "step",
              name: `tool_output:${toolName}`,
              toolCallId: toolCallId || lastToolCall?.toolCallId,
              status: "completed",
              output: toolResult,
            });

            // Process special events (console modifications, etc.)
            const specialEvent = processToolResult(toolResult);
            if (specialEvent) {
              const modificationId = `mod-${Date.now()}`;
              console.log(
                `[Agent V2] Sending ${specialEvent.type} event:`,
                specialEvent.data,
              );

              if (specialEvent.type === "console_modification") {
                const data = specialEvent.data as {
                  modification: unknown;
                  consoleId?: string;
                };
                sendEvent({
                  type: "console_modification",
                  modificationId,
                  modification: data.modification,
                  consoleId: data.consoleId || effectiveConsoleId,
                });
              } else if (specialEvent.type === "console_creation") {
                const data = specialEvent.data as {
                  consoleId: string;
                  title: string;
                  content: string;
                  connectionId?: string;
                  databaseId?: string;
                  databaseName?: string;
                };
                sendEvent({
                  type: "console_creation",
                  consoleId: data.consoleId,
                  title: data.title,
                  content: data.content,
                  connectionId: data.connectionId,
                  databaseId: data.databaseId,
                  databaseName: data.databaseName,
                });
              }
            }
          } else if (chunk.type === "error") {
            console.error("[Agent V2] Stream error:", chunk.error);
            errorPersisted = true;
            sendEvent({
              type: "error",
              message: String(chunk.error) || "An error occurred",
            });
          }
        }

        // Update chat with assistant response
        if (
          !errorPersisted &&
          (assistantReply.trim() || toolCalls.length > 0)
        ) {
          await updateChatWithResponse(
            currentSessionId,
            assistantReply,
            toolCalls.length > 0 ? toolCalls : undefined,
            uiAgentMode,
          );
        }

        // Fetch updated message count for thread info
        const updatedChat = await Chat.findById(currentSessionId);
        const messageCount = updatedChat?.messages?.length || 0;

        sendEvent({
          type: "thread_info",
          threadId: threadContext.threadId,
          messageCount,
        });

        // Fire-and-forget: generate chat title if needed
        void (async () => {
          try {
            if (!currentSessionId) return;
            const chat = await Chat.findById(currentSessionId);
            if (!chat || chat.titleGenerated) return;
            const allMessages = chat.messages || [];
            if (!shouldGenerateTitle(allMessages)) return;
            const title = await generateChatTitle(allMessages);
            const trimmed = (title || "").trim();
            if (!trimmed) return;
            await Chat.findOneAndUpdate(
              {
                _id: new ObjectId(currentSessionId),
                workspaceId: new ObjectId(workspaceId),
                createdBy: userId.toString(),
                titleGenerated: false,
              },
              { title: trimmed, titleGenerated: true, updatedAt: new Date() },
              { new: true },
            );
          } catch (e) {
            console.error("[Agent V2] Title generation error:", e);
          }
        })();

        // Close the stream
        isClosed = true;
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err: unknown) {
        const error = err as Error;
        console.error("[Agent V2] /api/agent/v2/stream error", error);

        if (currentSessionId) {
          void persistChatError(
            currentSessionId,
            {
              message: error.message || "Unexpected error",
              code: (error as { code?: string }).code,
              type: "unexpected_error",
            },
            toolCalls,
            assistantReply,
          );
        }

        sendEvent({
          type: "error",
          message: error.message || "Unexpected error",
          code: (error as { code?: string }).code,
        });
        isClosed = true;
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      }
    },
  });

  return new Response(stream, {
    headers: {
      "Content-Type": "text/event-stream",
      "Cache-Control": "no-cache",
      Connection: "keep-alive",
      "X-Accel-Buffering": "no",
    },
  });
});

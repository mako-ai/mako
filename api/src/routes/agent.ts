import { Hono } from "hono";
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – module will be provided via dependency at runtime
import { run as runAgent } from "@openai/agents";
import { ObjectId } from "mongodb";
// title generation handled elsewhere; not used here
import { Chat, DatabaseConnection } from "../database/workspace-schema";
import { createAgent, AgentKind } from "../agent";
import {
  getOrCreateThreadContext,
  buildAgentContext,
  persistChatSession,
} from "../services/agent-thread.service";
import {
  shouldGenerateTitle,
  generateChatTitle,
} from "../services/title-generator";
import { unifiedAuthMiddleware } from "../auth/unified-auth.middleware";
import { AuthenticatedContext } from "../middleware/workspace.middleware";
import {
  selectInitialAgent,
  getSelectionConfidence,
} from "../services/agent-selection.service";

// Create a router that will be mounted at /api/agent
export const agentRoutes = new Hono();

// Apply unified auth middleware to all agent routes
agentRoutes.use("*", unifiedAuthMiddleware);

// thread helpers moved to services

// removed DB helper/tool definitions from route

// removed DB helper/tool definitions from route

// removed DB helper/tool definitions from route

// removed DB helper/tool definitions from route

// ------------------------------------------------------------------------------------
// Tool wrappers: MongoDB
// ------------------------------------------------------------------------------------

// removed DB helper/tool definitions from route

// removed DB helper/tool definitions from route

// triage tools now provided implicitly through sub-agents' handoffs

// ------------------------------------------------------------------------------------
// Agent definitions with thread awareness and modes
// ------------------------------------------------------------------------------------

type AgentMode = "mongo" | "bigquery" | "postgres" | "triage";

// persistence moved to services

// ------------------------------------------------------------------------------------
// POST /stream - Threaded version with optimized context management
// ------------------------------------------------------------------------------------

agentRoutes.post("/stream", async (c: AuthenticatedContext) => {
  // Get authenticated user
  const user = c.get("user");
  const userId = user?.id;

  if (!userId) {
    return c.json({ error: "User not authenticated" }, 401);
  }

  let body: any = {};
  try {
    body = await c.req.json();
  } catch (e) {
    console.error("Error parsing request body", e);
  }

  const { message, sessionId, workspaceId, consoles, consoleId } = body as {
    message?: string;
    sessionId?: string;
    workspaceId?: string;
    consoles?: any[];
    consoleId?: string; // Explicit console ID to pin
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

  // No pre-detection; triage decides or we use pinned agent

  // Get or create thread context
  const threadContext = await getOrCreateThreadContext(
    sessionId,
    workspaceId,
    userId.toString(),
  );

  // Build optimized context for the agent
  const agentInput = buildAgentContext(threadContext, message.trim());

  // TODO: Replace with proper logging
  // console.log("Thread context:", {
  //   threadId: threadContext.threadId,
  //   recentMessagesCount: threadContext.recentMessages.length,
  //   totalMessages: threadContext.metadata.messageCount,
  // });

  const encoder = new TextEncoder();

  const stream = new ReadableStream({
    async start(controller) {
      let isClosed = false;

      const sendEvent = (data: any) => {
        if (isClosed) return;
        try {
          controller.enqueue(
            encoder.encode(`data: ${JSON.stringify(data)}\n\n`),
          );
        } catch (e) {
          console.error("Failed to send event:", e);
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

        // Get workspace database capabilities for smart selection
        const workspaceDatabases = await DatabaseConnection.find({
          workspaceId: new ObjectId(workspaceId),
        }).select({ type: 1, name: 1 });

        const workspaceHasMongoDB = workspaceDatabases.some(
          db => db.type === "mongodb",
        );
        const workspaceHasBigQuery = workspaceDatabases.some(
          db => db.type === "bigquery",
        );
        const workspaceHasPostgres = workspaceDatabases.some(
          db => db.type === "postgresql" || db.type === "cloudsql-postgres",
        );

        // Create a map of database IDs to their types for quick lookup
        const databaseTypeMap = new Map<string, string>();
        workspaceDatabases.forEach(db => {
          databaseTypeMap.set(db._id.toString(), db.type);
        });

        // Enrich consoles with connection type information
        const enrichedConsoles = (consoles || []).map((c: any) => ({
          ...c,
          // connectionId is the DatabaseConnection MongoDB ObjectId - keep it as-is
          connectionId: c.connectionId,
          connectionType:
            c.connectionType ||
            c.metadata?.connectionType ||
            (c.connectionId ? databaseTypeMap.get(c.connectionId) : undefined),
          databaseName: c.databaseName || c.metadata?.selectedDatabaseName,
        }));

        // Use smart agent selection
        const sessionActiveAgent = (pinned as any)?.activeAgent as
          | AgentKind
          | undefined;
        const selectedAgent = selectInitialAgent({
          sessionActiveAgent,
          userMessage: message,
          consoles: enrichedConsoles,
          workspaceHasMongoDB,
          workspaceHasBigQuery,
          workspaceHasPostgres,
        });

        // Log selection confidence for debugging
        const selectionInfo = getSelectionConfidence(
          {
            sessionActiveAgent,
            userMessage: message,
            consoles: enrichedConsoles,
            workspaceHasMongoDB,
            workspaceHasBigQuery,
            workspaceHasPostgres,
          },
          selectedAgent,
        );
        console.log(
          `Agent selection: ${selectionInfo.agent} (${selectionInfo.confidence} confidence) - ${selectionInfo.reason}`,
        );

        const activeAgent: AgentMode = selectedAgent as AgentMode;

        // Use pinned console ID if available
        const effectiveConsoleId =
          consoleId || (pinned as any)?.pinnedConsoleId;

        const agentInstance = createAgent(activeAgent as AgentKind, {
          workspaceId,
          consoles: enrichedConsoles,
          preferredConsoleId: effectiveConsoleId,
        });

        const runStream: any = await runAgent(agentInstance, agentInput, {
          stream: true,
          maxTurns: 100, // Allow enough turns for handoffs to complete
        });

        let assistantReply = "";
        let _eventCount = 0;
        let _textDeltaCount = 0;
        let currentAgent = activeAgent;
        let handoffOccurred = false;
        const toolCalls: Array<{
          toolName: string;
          timestamp: Date;
          status: "started" | "completed";
          input?: any;
          result?: any;
        }> = [];

        try {
          for await (const event of runStream as AsyncIterable<any>) {
            _eventCount++;

            // Log all event types for debugging
            if (event?.type) {
              console.log(`[Agent Stream] Event type: ${event.type}`, {
                eventCount: _eventCount,
                hasData: !!event.data,
                hasItem: !!event.item,
              });
            }

            // Process text deltas
            if (event?.type === "raw_model_stream_event") {
              const data = event.data;

              let textDelta = null;
              if (data?.type === "output_text_delta") {
                textDelta = data.delta;
              } else if (data?.type === "response.output_text.delta") {
                textDelta = data.delta;
              } else if (data?.type === "text_delta") {
                textDelta = data.delta;
              } else if (data?.type === "content.delta") {
                textDelta = data.text || data.delta;
              }

              if (textDelta && typeof textDelta === "string") {
                _textDeltaCount++;
                assistantReply += textDelta;
                sendEvent({ type: "text", content: textDelta });
              }
            }

            // Process tool events
            if (event?.type === "run_item_stream_event") {
              const itemEvent = event;
              const item = itemEvent.item;

              // Debug logging for all item types
              if (item?.type) {
                console.log(
                  `[Agent Stream] Item type: ${item.type}, Event name: ${itemEvent.name}`,
                );
                if (
                  item.type === "handoff_call_item" ||
                  item.type === "handoff_output_item" ||
                  item.type === "handoff_item" ||
                  item.type.includes("handoff")
                ) {
                  console.log(
                    `[Agent Stream] Handoff item:`,
                    JSON.stringify(item, null, 2),
                  );
                }
              }

              // Handle handoff events - just track them, don't interfere
              if (
                item?.type === "handoff_call_item" ||
                item?.type === "handoff_output_item"
              ) {
                const handoffAgent =
                  item.handoff_output?.agent_name ||
                  item.agent_name ||
                  item.name;
                console.log(
                  `[Agent Stream] Handoff detected to: ${handoffAgent}`,
                );

                // Track handoff as a tool call
                if (item?.type === "handoff_call_item") {
                  handoffOccurred = true;
                  const agentNameLower = (handoffAgent || "").toLowerCase();
                  const handoffToolName = agentNameLower.includes("mongodb")
                    ? "transfer_to_mongodb"
                    : agentNameLower.includes("bigquery")
                      ? "transfer_to_bigquery"
                      : agentNameLower.includes("postgres")
                        ? "transfer_to_postgres"
                        : "handoff";

                  toolCalls.push({
                    toolName: handoffToolName,
                    timestamp: new Date(),
                    status: "completed",
                    result: { agent: handoffAgent },
                  });

                  // Clear any assistant reply that might be a handoff message
                  assistantReply = "";
                }

                // Just notify the UI about the handoff, let the library handle the actual transition
                if (handoffAgent) {
                  const handoffAgentLower = handoffAgent.toLowerCase();
                  if (handoffAgentLower.includes("mongodb")) {
                    currentAgent = "mongo";
                  } else if (handoffAgentLower.includes("bigquery")) {
                    currentAgent = "bigquery";
                  } else if (handoffAgentLower.includes("postgres")) {
                    currentAgent = "postgres";
                  }
                  sendEvent({
                    type: "agent_mode",
                    mode: currentAgent,
                  });

                  const agentLabel =
                    currentAgent === "mongo"
                      ? "MongoDB"
                      : currentAgent === "bigquery"
                        ? "BigQuery"
                        : currentAgent === "postgres"
                          ? "Postgres"
                          : "Database";

                  // Send handoff notification event
                  sendEvent({
                    type: "handoff",
                    agent: currentAgent,
                    message: `Switching to ${agentLabel} assistant...`,
                  });
                }
              }

              if (
                item?.type === "tool_call_item" &&
                itemEvent.name === "tool_called"
              ) {
                const toolName =
                  item.rawItem?.function?.name ||
                  item.rawItem?.name ||
                  item.function?.name ||
                  item.name ||
                  "unknown_tool";

                // Attempt to extract tool input/arguments from multiple possible locations
                const rawInput =
                  item.rawItem?.function?.arguments ??
                  item.function?.arguments ??
                  item.rawItem?.arguments ??
                  item.arguments ??
                  item.input ??
                  item.payload ??
                  item.params ??
                  item.parameters;

                let parsedInput = rawInput;
                if (typeof rawInput === "string") {
                  try {
                    parsedInput = JSON.parse(rawInput);
                  } catch {
                    // leave as string if not JSON
                  }
                }

                // Debug log tool calls
                if (toolName.includes("console")) {
                  console.log(`[Agent Stream] Tool called: ${toolName}`, {
                    itemType: item.type,
                    rawItem: item.rawItem,
                    function: item.function,
                    name: item.name,
                  });
                }

                sendEvent({
                  type: "step",
                  name: `tool_called:${toolName}`,
                  status: "started",
                  input: parsedInput,
                });

                // Track tool call
                toolCalls.push({
                  toolName,
                  timestamp: new Date(),
                  status: "started",
                  input: parsedInput,
                });
              }

              if (
                item?.type === "tool_call_output_item" &&
                (itemEvent.name === "output_added" ||
                  itemEvent.name === "tool_output")
              ) {
                // Get tool name from various possible locations
                const toolName =
                  item.rawItem?.function?.name ||
                  item.rawItem?.name ||
                  item.function?.name ||
                  item.name ||
                  item.tool_call_name ||
                  // Try to get from the associated tool call
                  item.rawItem?.callId ||
                  "completed_tool";

                // Always log tool output items to debug
                console.log(
                  `[Agent Stream] Tool output for ${toolName}:`,
                  JSON.stringify(
                    {
                      type: item.type,
                      eventName: itemEvent.name,
                      output: item.output,
                      result: item.result,
                      rawItem: item.rawItem,
                      tool_call_name: item.tool_call_name,
                      // Check all possible fields
                      allKeys: Object.keys(item),
                    },
                    null,
                    2,
                  ),
                );

                // Compute output before sending event
                const output =
                  item.output ||
                  item.result ||
                  item.rawItem?.output ||
                  item.rawItem?.result ||
                  item.rawItem?.providerData?.output ||
                  item.providerData?.output;

                sendEvent({
                  type: "step",
                  name: `tool_output:${toolName}`,
                  status: "completed",
                  output,
                });

                // Find the matching started tool call and update it
                const lastToolCall = toolCalls
                  .filter(
                    tc => tc.toolName === toolName && tc.status === "started",
                  )
                  .pop();

                if (lastToolCall) {
                  lastToolCall.status = "completed";
                  lastToolCall.result = output;
                } else {
                  // If no matching started call, create a new completed entry
                  toolCalls.push({
                    toolName,
                    timestamp: new Date(),
                    status: "completed",
                    result: output,
                  });
                }

                // Check for console-related tool outputs

                // Also check if this is specifically a console tool
                const isConsoleToolOutput =
                  toolName.includes("console") ||
                  toolName === "modify_console" ||
                  toolName === "create_console";

                if (isConsoleToolOutput) {
                  console.log(
                    `[Agent Stream] Processing ${toolName} output, output field:`,
                    output,
                  );
                }

                if (output !== undefined && output !== null) {
                  try {
                    const outputData =
                      typeof output === "string" ? JSON.parse(output) : output;

                    // Debug logging for tool outputs
                    if (isConsoleToolOutput) {
                      console.log(
                        `[Agent Stream] ${toolName} parsed output:`,
                        JSON.stringify(outputData, null, 2),
                      );
                    }

                    // Handle console modifications and creations based on event markers
                    if (
                      outputData?._eventType === "console_modification" &&
                      outputData?.success
                    ) {
                      console.log(
                        "[Agent Stream] Sending console_modification event:",
                        {
                          modification: outputData.modification,
                          consoleId: outputData.consoleId || effectiveConsoleId,
                        },
                      );
                      sendEvent({
                        type: "console_modification",
                        modification: outputData.modification,
                        consoleId: outputData.consoleId || effectiveConsoleId,
                      });
                    } else if (
                      outputData?._eventType === "console_creation" &&
                      outputData?.success
                    ) {
                      console.log(
                        "[Agent Stream] Sending console_creation event:",
                        {
                          consoleId: outputData.consoleId,
                          title: outputData.title,
                        },
                      );
                      sendEvent({
                        type: "console_creation",
                        consoleId: outputData.consoleId,
                        title: outputData.title,
                        content: outputData.content,
                      });
                    }
                  } catch (e) {
                    console.error("Failed to parse tool output:", e);
                    console.error("Raw output was:", output);
                  }
                } else if (isConsoleToolOutput) {
                  // If it's a console tool but no output found, log this for debugging
                  console.error(
                    `[Agent Stream] No output found for ${toolName} tool!`,
                  );
                  console.error(
                    "Item structure:",
                    JSON.stringify(
                      {
                        type: item.type,
                        hasOutput: "output" in item,
                        hasResult: "result" in item,
                        hasRawItem: !!item.rawItem,
                        rawItemKeys: item.rawItem
                          ? Object.keys(item.rawItem)
                          : [],
                      },
                      null,
                      2,
                    ),
                  );
                }
              }

              if (itemEvent.name === "message_output_created") {
                sendEvent({
                  type: "step",
                  name: "message_generation",
                  status: "started",
                });
              }
            }
          }
        } catch (streamError: any) {
          // Handle stream processing errors
          console.error("Stream processing error:", streamError);

          // Don't throw, just log and continue to close gracefully
          if (streamError.message !== "terminated") {
            sendEvent({
              type: "error",
              message: "Stream processing error",
            });
          }
        }

        try {
          await runStream.completed;
        } catch (completionError: any) {
          console.error("Stream completion error:", completionError);
          // Continue anyway - we may have partial results
        }

        // Check if we got any final output from the stream
        if (!assistantReply && runStream.finalOutput) {
          assistantReply = runStream.finalOutput;
          sendEvent({ type: "text", content: assistantReply });
        }

        // Important: If a handoff occurred but no text was generated, the stream should have continued
        // with the new agent. We should only save messages when we have actual content.
        if (assistantReply.trim() || (!handoffOccurred && message.trim())) {
          // Update messages with the new conversation turn
          const allMessages = [
            ...threadContext.recentMessages,
            { role: "user" as const, content: message.trim() },
          ];

          // Only add assistant message if there's actual content
          if (assistantReply.trim()) {
            allMessages.push({
              role: "assistant" as const,
              content: assistantReply,
              toolCalls: toolCalls.length > 0 ? toolCalls : undefined,
            });
          }

          // Persist the chat session with thread management and pinning
          const finalSessionId = await persistChatSession(
            sessionId,
            threadContext,
            allMessages,
            workspaceId,
            currentAgent,
            userId.toString(),
            consoleId, // Pin the console if provided
          );

          // Send thread info
          sendEvent({
            type: "thread_info",
            threadId: threadContext.threadId,
            messageCount: allMessages.length,
          });

          sendEvent({ type: "session", sessionId: finalSessionId });

          // Fire-and-forget: generate a descriptive chat title if not already set
          void (async () => {
            try {
              // Only attempt if we have a valid session id and enough context
              if (!finalSessionId) return;

              if (!shouldGenerateTitle(allMessages)) return;

              const title = await generateChatTitle(allMessages);
              const trimmed = (title || "").trim();
              if (!trimmed) return;

              await Chat.findOneAndUpdate(
                {
                  _id: new ObjectId(finalSessionId),
                  workspaceId: new ObjectId(workspaceId),
                  createdBy: userId.toString(),
                  titleGenerated: false,
                },
                { title: trimmed, titleGenerated: true, updatedAt: new Date() },
                { new: true },
              );
            } catch (e) {
              console.error("Title generation error:", e);
            }
          })();
        }

        // Close the stream
        isClosed = true;
        controller.enqueue(encoder.encode("data: [DONE]\n\n"));
        controller.close();
      } catch (err: any) {
        console.error("/api/agent/stream error", err);
        sendEvent({
          type: "error",
          message: err.message || "Unexpected error",
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

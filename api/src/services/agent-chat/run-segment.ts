/**
 * One generation segment of a chat turn: model call, UI message stream,
 * resumable-stream setup and the hand-off to finalization.
 *
 * Segment 0 is the normal request-driven generation. Further segments exist
 * only for the "no client attached" fallback (stranded-turn.ts): when a
 * segment ends stranded on client-only tool calls with no browser attached,
 * finalization synthesizes the tool results and starts the next segment
 * server-side (the continuation's Response body has no HTTP consumer; the
 * resumable stream still buffers it for reattaching clients).
 */
import {
  createUIMessageStreamResponse,
  isStepCount,
  streamText,
  toUIMessageStream,
  type UIMessage,
} from "ai";
import { ObjectId } from "mongodb";

import { buildPromptCacheHeaders } from "../../agent-lib/ai-gateway";
import {
  buildClientStreamErrorPayload,
  describeStreamError,
} from "../../agent-lib/stream-error";
import {
  toolFailureFromOutput,
  toolFailureFromThrown,
} from "../../agent-lib/tool-failure";
import { repairStringifiedToolInputs } from "../../agent-lib/tool-input-repair";
import { Chat } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { scheduleChatFinalization } from "./finalization-queue";
import { saveChat } from "../agent-thread.service";
import {
  trackTurnCheckpoints,
  withSseKeepAlive,
} from "../agent-stream.service";
import { computeCostFromTokens } from "../cost-calculator";
import { lookupPricing } from "../gateway-pricing.service";
import { reportPubSubFailure } from "../pubsub.service";
import { publishRealtimeEvent } from "../realtime.service";
import {
  getResumableStreamContext,
  registerActiveGeneration,
} from "../resumable-stream.service";
import { finalizeSegment } from "./finalize-segment";
import { buildSegmentModelMessages } from "./segment-messages";
import { MAX_STEPS, type ChatTurn } from "./turn";
import { totalsFromFinishUsage } from "./turn-usage";

const logger = loggers.agent();

/**
 * Persist the conversation as of turn start (which includes this turn's user
 * message — until now it only existed in the request body), register the
 * resumable stream and point the chat at it.
 *
 * A client that reloads mid-turn can then render the full history from
 * MongoDB and layer the resumed SSE replay (assistant chunks only) on top.
 * The save also bumps updatedAt so the in-flight chat sorts to the top of the
 * history list. It is scheduled through the per-chat finalization queue so a
 * fast turn's finalization (full message set) can never be overwritten by
 * this earlier snapshot.
 */
async function setUpResumableStream(
  turn: ChatTurn,
  segmentUiMessages: UIMessage[],
  stream: ReadableStream<string>,
  streamId: string,
): Promise<void> {
  const { chatId, workspaceId, actorId } = turn;
  scheduleChatFinalization(chatId, async () => {
    try {
      await saveChat(chatId, workspaceId, actorId, segmentUiMessages);
    } catch (error) {
      logger.warn("Failed to persist turn-start messages", { error, chatId });
    }
  });

  // §13.27: a second consumer of the same SSE bytes checkpoints the
  // in-progress assistant message every couple of seconds, so a process
  // death mid-turn costs seconds of work, not the turn.
  const [resumeBranch, checkpointBranch] = stream.tee();
  void trackTurnCheckpoints({
    chatId,
    streamId,
    sseStream: checkpointBranch,
  });
  try {
    registerActiveGeneration(chatId, streamId, turn.abort.controller);
    await getResumableStreamContext().createNewResumableStream(
      streamId,
      () => resumeBranch,
    );
    await Chat.updateOne(
      { _id: new ObjectId(chatId) },
      { $set: { activeStreamId: streamId } },
    );
    // Live activity indicators: open windows light up the chat in the
    // history menu without polling.
    publishRealtimeEvent(workspaceId, {
      type: "chat.activity",
      chatId,
      state: "streaming",
    });
  } catch (error) {
    // Resumability is best-effort: the direct response stream to the
    // originating client is unaffected by failures here. But it failing
    // means reload/second-device reattach is silently broken for this turn —
    // log at ERROR so Error Reporting alerts (the Upstash quota exhaustion
    // hid behind a warn), and feed the throttled backend-level reporter.
    logger.error("Failed to set up resumable stream", {
      error,
      chatId,
      streamId,
    });
    reportPubSubFailure("resumable-stream-setup", error);
  }
}

export async function runSegment(
  turn: ChatTurn,
  segmentUiMessages: UIMessage[],
  continuationDepth: number,
): Promise<Response> {
  const { chatId, workspaceId, agentId, modelId, tools } = turn;
  const modelMessages = await buildSegmentModelMessages(
    turn,
    segmentUiMessages,
    continuationDepth === 0,
  );
  const startTime = Date.now();
  let stepsCompleted = 0;
  // Stream ID minted in consumeSseStream once the SSE stream starts; used by
  // finalization to clear the resume pointer for exactly this segment.
  let turnStreamId: string | null = null;

  // Pricing rows for the live per-response cost metadata below. The
  // messageMetadata callback is synchronous, so resolve the (cached) gateway
  // pricing up front. Empty rows → costUsd omitted, tokens still sent. Never
  // let a pricing hiccup block the turn.
  const metadataPricingRows = await lookupPricing(modelId).catch(() => []);

  const result = streamText({
    model: turn.model,
    instructions: turn.systemPrompt,
    messages: modelMessages,
    tools,
    ...(turn.prepareStep
      ? {
          prepareStep: turn.prepareStep as Parameters<
            typeof streamText
          >[0]["prepareStep"],
        }
      : {}),
    stopWhen: isStepCount(MAX_STEPS),
    // Deterministic fix-up for models that emit tool args with nested values
    // JSON-stringified (e.g. an array param as "[\"...\"]"), which otherwise
    // fail schema validation and dead-end the tool call. See
    // agent-lib/tool-input-repair.ts.
    repairToolCall: repairStringifiedToolInputs,
    // The Langfuse span is marked by withToolFailureObservation; this
    // callback runs after the tool span's context has exited.
    onToolExecutionEnd(event) {
      const failure =
        event.toolOutput.type === "tool-error"
          ? toolFailureFromThrown(event.toolOutput.error)
          : toolFailureFromOutput(event.toolOutput.output);
      if (!failure) return;
      logger.error("Agent tool call failed", {
        workspaceId,
        chatId,
        agentId,
        modelId,
        toolName: event.toolCall.toolName,
        toolCallId: event.toolCall.toolCallId,
        toolErrorMessage: failure.message,
        toolErrorCode: failure.code,
        durationMs: event.toolExecutionMs,
        toolExecution: "server",
        error: {
          name: "ToolExecutionError",
          message: failure.message,
          ...(failure.code ? { code: failure.code } : {}),
        },
      });
    },
    providerOptions: turn.providerOptions,
    headers: buildPromptCacheHeaders(chatId),
    abortSignal: turn.abort.signal,
    telemetry: { functionId: `agent-chat:${agentId}` },
    // The AI SDK's default onError is a bare console.error(error) —
    // unstructured and without any request context, which made
    // provider-scoped gateway failures (e.g. a 401 for one provider while
    // others work) effectively untraceable. Log the full description so
    // failed turns can be found by chatId / model / gateway generationId in
    // logs and alerting.
    onError({ error }: { error: unknown }) {
      logger.error("Chat model stream error", {
        ...describeStreamError(error),
        chatId,
        workspaceId,
        agentId,
        modelId,
        continuationDepth,
        error,
      });
    },
    onStepEnd({ toolCalls }: { toolCalls?: Array<unknown> }) {
      stepsCompleted += 1;
      logger.debug("Step finished", {
        step: stepsCompleted,
        maxSteps: MAX_STEPS,
        toolCallCount: toolCalls?.length,
      });
      if (stepsCompleted >= MAX_STEPS) {
        logger.warn("Step limit reached, terminating tool loop", {
          maxSteps: MAX_STEPS,
        });
      }
    },
  });

  // Drain the stream server-side so generation runs to completion and onEnd
  // below always fires — even when the client disconnects (network drop, tab
  // close) or aborts via the Stop button. Without this the HTTP response
  // stops being pulled on disconnect, onEnd never runs, and the entire
  // assistant turn (and any tool work) is lost. Disconnects no longer abort
  // the turn (the turn signal only fires via the explicit stop endpoint);
  // the resumable stream below lets clients reattach mid-turn.
  void result.consumeStream({
    onError: error =>
      logger.warn("Error draining chat stream", { error, chatId }),
  });

  // Native AI SDK UI message stream response (useChat compatibility). AI SDK
  // best practice: save once at the end with all messages.
  const streamResponse = createUIMessageStreamResponse({
    stream: toUIMessageStream({
      stream: result.stream,
      tools,
      originalMessages: segmentUiMessages,
      generateMessageId: () => new ObjectId().toString(),
      // Per-response cost for the chat UI: on the finish part, price the
      // segment's total usage with the prefetched gateway pricing. This lands
      // in `message.metadata` client-side and survives resumable-stream
      // replay. (Authoritative billing still happens in finalization via
      // computeInvocationCost, which prices per-step models; this display
      // value prices totals at the resolved model — the two only diverge on
      // multi-model turns.)
      messageMetadata: ({ part }) => {
        if (part.type !== "finish") return undefined;
        const tokens = totalsFromFinishUsage(part.totalUsage);
        const costUsd =
          metadataPricingRows.length > 0
            ? computeCostFromTokens(tokens, metadataPricingRows)
            : undefined;
        // Cache and reasoning counts ride along so the client's session total
        // can break them out live. They are SUBSETS (cache of input,
        // reasoning of output) — the client must not add them on top, and
        // `totalTokens` deliberately excludes them.
        return {
          costUsd,
          modelId,
          inputTokens: tokens.inputTokens,
          outputTokens: tokens.outputTokens,
          cacheReadTokens: tokens.cacheReadTokens,
          cacheWriteTokens: tokens.cacheWriteTokens,
          reasoningTokens: tokens.reasoningTokens,
        };
      },
      // Replace the SDK's raw error text (for gateway auth failures a
      // misleading "configure AI_GATEWAY_API_KEY" message) with the
      // structured `{ code, message, ... }` JSON envelope. The client treats
      // JSON errors with a `code` as terminal server errors: it renders
      // `message` immediately instead of burning resume retries on a turn
      // that is already dead.
      onError: (error: unknown) =>
        buildClientStreamErrorPayload(error, modelId),
      // Forward reasoning tokens from models that support extended thinking.
      sendReasoning: true,
      onEnd: ({ messages: allMessages, isAborted }) => {
        // Run finalization in the background so it does not block the UI
        // message stream from closing. The AI SDK awaits onEnd inside the
        // stream's flush(), and useChat only fires the tool-result
        // auto-resume once the stream closes — so any slow work here (cost
        // computation, saveChat, etc.) is serialized into the user-perceived
        // latency of every client-side tool round-trip, making fast tools
        // (e.g. an instant modify_console patch) appear frozen.
        scheduleChatFinalization(chatId, () =>
          finalizeSegment({
            turn,
            result,
            allMessages,
            isAborted,
            startTime,
            continuationDepth,
            getStreamId: () => turnStreamId,
            runSegment,
          }),
        );
      },
    }),
    // Buffer a tee'd copy of the SSE stream so detached clients (refresh,
    // other devices, additional viewers) can reattach via
    // GET /chat/:chatId/stream while the turn is still generating. The
    // chat's activeStreamId is the resume pointer; finalization clears it.
    consumeSseStream: async ({ stream }) => {
      const streamId = new ObjectId().toString();
      // Set before any await so finalization always sees it.
      turnStreamId = streamId;
      await setUpResumableStream(turn, segmentUiMessages, stream, streamId);
    },
  });

  return withSseKeepAlive(streamResponse);
}

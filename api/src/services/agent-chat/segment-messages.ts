/**
 * Prompt assembly for one generation segment: the UI history the client
 * replayed, turned into the model messages actually sent.
 *
 * - Resolves object-storage-backed image attachments (from reopened chats)
 *   back into inline data URLs the provider can read. Runs before
 *   sanitization so its empty-parts guard covers any message left with no
 *   parts after a missing attachment is dropped.
 * - Sanitizes messages to remove incomplete tool calls from interrupted
 *   streams (prevents Anthropic "tool_use ids without tool_result" errors).
 * - Screenshot vision attachments ride only on the FIRST segment (they are
 *   consumed from the originating request).
 */
import { convertToModelMessages, type UIMessage } from "ai";

import {
  compactUiMessagesForBudget,
  computeInputBudget,
  dedupeAssistantReasoning,
  elideOldToolOutputs,
  stripReplayedReasoning,
} from "../../agent-lib/context/compaction";
import { capToolPartOutputsForModel } from "../../agent-lib/tools/shared/output-cap";
import { loggers } from "../../logging";
import { sanitizeMessagesForModel } from "../../utils/message-sanitizer";
import { buildScreenshotVisionModelMessage } from "../agent-stream.service";
import { resolveChatAttachmentsForModel } from "../chat-attachment.service";
import type { ChatTurn } from "./turn";

const logger = loggers.agent();

export async function buildSegmentModelMessages(
  turn: ChatTurn,
  segmentUiMessages: UIMessage[],
  includeVisionAttachments: boolean,
) {
  const { chatId, workspaceId, modelId } = turn;
  const logContext = { chatId, workspaceId, modelId };

  const messagesWithAttachments = await resolveChatAttachmentsForModel(
    segmentUiMessages,
    workspaceId,
    { supportsVision: turn.modelSupportsVision },
  );
  // Cap replayed tool outputs the execute-time backstop never saw:
  // client-executed tool results, chats persisted before the caps, and
  // app_browse screenshots the client still carries as base64.
  const toolPartCaps = capToolPartOutputsForModel(
    sanitizeMessagesForModel(messagesWithAttachments),
  );
  if (toolPartCaps.changed) {
    logger.info("Capped replayed tool outputs before generation", {
      ...logContext,
      cappedCount: toolPartCaps.cappedCount,
      screenshotsDropped: toolPartCaps.screenshotsDropped,
    });
  }
  // Always-on cost control (budget-independent): the client replays the
  // entire `messages[]` every turn, so a long session re-sends every prior
  // turn's full tool outputs on every request — re-billed as input tokens
  // each time, even when the prompt comfortably fits the context window.
  // Elide large tool outputs from older turns (keeping the most recent turns
  // verbatim) before any budget math. This is the main lever against runaway
  // spend on long chats. Runs even when `contextWindow` is unknown.
  const elision = elideOldToolOutputs(toolPartCaps.messages);
  let messagesForModel = elision.messages;
  if (elision.changed) {
    logger.info("Elided old tool outputs before generation", {
      ...logContext,
      elidedCount: elision.elidedCount,
    });
  }
  // Strip replayed thinking/reasoning traces. `sendReasoning: true` persists
  // the model's thinking and the client replays it every turn; a model never
  // needs to re-read its own past thinking, and those blocks are re-billed as
  // input tokens each request. Kept only on the assistant turn being
  // continued with tool results (Anthropic interleaved-thinking requirement).
  const reasoningStrip = stripReplayedReasoning(messagesForModel);
  messagesForModel = reasoningStrip.messages;
  if (reasoningStrip.changed) {
    logger.info("Stripped replayed reasoning before generation", {
      ...logContext,
      strippedCount: reasoningStrip.strippedCount,
    });
  }
  // Collapse duplicate reasoning parts on the assistant turn(s) preserved
  // above. A persisted assistant message can accumulate duplicate thinking
  // blocks (streamed parts merged with `originalMessages`, resumable-stream
  // replay, persist→reload). On a tool-use continuation Anthropic requires
  // the latest assistant message's thinking blocks to be replayed
  // byte-for-byte unmodified, and a duplicate IS a modification — the turn
  // is rejected with "thinking ... blocks in the latest assistant message
  // cannot be modified", permanently wedging the chat. De-duping restores the
  // original sequence so the turn round-trips.
  const reasoningDedupe = dedupeAssistantReasoning(messagesForModel);
  messagesForModel = reasoningDedupe.messages;
  if (reasoningDedupe.changed) {
    logger.info("De-duplicated replayed reasoning before generation", {
      ...logContext,
      removedCount: reasoningDedupe.removedCount,
    });
  }
  // Proactively keep the prompt under the model's context window. Budget is
  // derived from the catalog `contextWindow` (provider-agnostic — every
  // gateway model reports it); when unknown we skip this and rely on the
  // reactive overflow backstop wrapping the model. Tool calls/results live
  // as parts inside a single assistant UIMessage here, so compacting whole
  // messages preserves tool call↔result pairing automatically.
  const inputBudget = computeInputBudget({
    contextWindow: turn.modelDef?.contextWindow,
    systemText: turn.systemPrompt,
    thinkingBudgetTokens: turn.modelDef?.thinkingBudgetTokens,
  });
  if (inputBudget !== null) {
    const compaction = await compactUiMessagesForBudget({
      messages: messagesForModel,
      budgetTokens: inputBudget,
      summarize: true,
      abortSignal: turn.abort.signal,
    });
    messagesForModel = compaction.messages;
    if (compaction.didCompact) {
      logger.info("Compacted chat history before generation", {
        ...logContext,
        strategy: compaction.strategy,
        estimatedTokensBefore: compaction.estimatedTokensBefore,
        estimatedTokensAfter: compaction.estimatedTokensAfter,
        budgetTokens: inputBudget,
      });
    }
  }
  const modelMessages = await convertToModelMessages(messagesForModel);
  if (includeVisionAttachments) {
    const screenshotVisionMessage = buildScreenshotVisionModelMessage(
      turn.screenshotVisionAttachments,
      { supportsVision: turn.modelSupportsVision },
    );
    if (screenshotVisionMessage) {
      modelMessages.push(
        screenshotVisionMessage as (typeof modelMessages)[number],
      );
      logger.info("Attached screenshot images to model request", {
        chatId,
        workspaceId,
        count: turn.screenshotVisionAttachments?.length ?? 0,
      });
    }
  }
  return modelMessages;
}

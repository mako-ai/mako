import { Db } from "mongodb";
import { loggers } from "../logging";

const log = loggers.migration();

export const description =
  "Add parts array to chat messages for preserving chronological order (AI SDK v6 alignment)";

/**
 * Migration: Add parts field to existing chat messages
 *
 * Problem: Current implementation decomposes UIMessage.parts into separate fields
 * (content, reasoning, toolCalls), losing the original chronological order.
 * When restoring from history, parts are reconstructed in a fixed order
 * (tools first, then reasoning, then text), causing tool calls to appear
 * at the top instead of interspersed with responses.
 *
 * Solution: Store the parts array directly to preserve chronological order.
 *
 * This migration reconstructs parts from legacy fields for existing chats.
 * Note: The original order cannot be perfectly restored for existing data,
 * so we use the same order as the current restore logic: tools -> reasoning -> text
 *
 * New chats will store parts directly with correct chronological order.
 */
export async function up(db: Db): Promise<void> {
  const collections = await db.listCollections().toArray();
  const collectionNames = collections.map(c => c.name);

  if (!collectionNames.includes("chats")) {
    log.info("ℹ️  Collection 'chats' not found, skipping migration.");
    return;
  }

  // Find all chats where at least one message doesn't have parts
  // We check for messages that have content or toolCalls but no parts field
  const cursor = db.collection("chats").find({
    $or: [
      { "messages.parts": { $exists: false } },
      { "messages.parts": { $size: 0 } },
    ],
  });

  let processedChats = 0;
  let updatedMessages = 0;

  for await (const chat of cursor) {
    const messages = chat.messages || [];
    let chatModified = false;

    const updatedMessagesArray = messages.map(
      (msg: {
        id?: string;
        role: string;
        content?: string;
        reasoning?: string[];
        toolCalls?: Array<{
          toolCallId?: string;
          toolName: string;
          input?: unknown;
          result?: unknown;
        }>;
        parts?: unknown[];
        _id?: { toString(): string };
      }) => {
        // Skip if message already has parts
        if (msg.parts && Array.isArray(msg.parts) && msg.parts.length > 0) {
          return msg;
        }

        // Reconstruct parts from legacy fields
        // Note: Order cannot be perfectly restored, use same order as current restore logic
        const parts: Array<{
          type: string;
          text?: string;
          reasoning?: string;
          toolCallId?: string;
          toolName?: string;
          input?: unknown;
          output?: unknown;
          state?: string;
        }> = [];

        // 1. Add tool call parts first (for UI display - shows tool history)
        if (msg.toolCalls && Array.isArray(msg.toolCalls)) {
          for (const tc of msg.toolCalls) {
            if (!tc.toolName) continue;
            parts.push({
              type: `tool-${tc.toolName}`,
              toolCallId:
                tc.toolCallId ||
                `migrated-${tc.toolName}-${Date.now()}-${Math.random().toString(36).substring(7)}`,
              toolName: tc.toolName,
              input: tc.input ?? {},
              output: tc.result ?? null,
              state: "output-available",
            });
          }
        }

        // 2. Add reasoning parts
        if (msg.reasoning && Array.isArray(msg.reasoning)) {
          for (const reasoningText of msg.reasoning) {
            if (reasoningText) {
              parts.push({
                type: "reasoning",
                reasoning: reasoningText,
              });
            }
          }
        }

        // 3. Add text content part
        if (msg.content) {
          parts.push({ type: "text", text: msg.content });
        }

        // Only mark as modified if we actually added parts
        if (parts.length > 0) {
          chatModified = true;
          updatedMessages++;
        }

        return {
          ...msg,
          // Add message ID if not present (for AI SDK compatibility)
          id:
            msg.id ||
            msg._id?.toString() ||
            `migrated-${Date.now()}-${Math.random().toString(36).substring(7)}`,
          parts: parts.length > 0 ? parts : undefined,
        };
      },
    );

    // Only update if chat was modified
    if (chatModified) {
      await db
        .collection("chats")
        .updateOne(
          { _id: chat._id },
          { $set: { messages: updatedMessagesArray } },
        );
      processedChats++;
    }
  }

  log.info(
    `✅ Migration complete: Updated ${processedChats} chats with ${updatedMessages} messages now having parts array`,
  );
}

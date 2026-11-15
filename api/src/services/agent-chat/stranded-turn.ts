/**
 * Stranded-turn detection + continuation ("no client attached" fallback,
 * issue #475).
 *
 * A segment is stranded when it finished waiting on tool calls that only a
 * browser can execute (e.g. capture_screenshot, console tools), but no
 * browser window is attached to the workspace (refresh mid-call, tab
 * closed). The server then patches the pending tool parts with an in-band
 * "no client attached" result, persists, and runs the next segment itself so
 * the model can adapt and the turn survives end-to-end. Bounded so a model
 * that keeps calling browser tools can't loop forever.
 */
import type { UIMessage } from "ai";

import { Chat } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { saveChat } from "../agent-thread.service";
import { hasAttachedClients } from "../realtime-presence.service";
import type { ChatTurn } from "./turn";

const logger = loggers.agent();

export const MAX_NO_CLIENT_CONTINUATIONS = 3;
const STRANDED_GRACE_MS = 10_000;
export const NO_CLIENT_TOOL_RESULT = {
  success: false,
  error:
    "No client attached — this tool needs an open browser window in the workspace. Continue without it (use server-side tools) or summarize what you would have done.",
};
/** Human-in-the-loop tools must stay pending until a person answers. */
const HUMAN_IN_THE_LOOP_TOOLS = new Set([
  "ask_clarifying_questions",
  "submit_plan",
]);

type ToolPart = {
  type: string;
  state?: string;
  toolName?: string;
  input?: unknown;
};

function toolNameOf(part: ToolPart): string {
  return part.type === "dynamic-tool"
    ? (part.toolName ?? "")
    : part.type.slice("tool-".length);
}

/**
 * The last assistant message's pending tool parts when EVERY one of them is
 * a registered client-side tool (no execute function) and none is
 * human-in-the-loop; null when the segment is not stranded on client tools.
 */
export function findStrandedClientToolParts(
  allMessages: UIMessage[],
  tools: ChatTurn["tools"],
): { lastMessage: UIMessage; pendingParts: ToolPart[] } | null {
  const lastMessage = allMessages[allMessages.length - 1];
  if (!lastMessage || lastMessage.role !== "assistant") return null;

  const pendingParts = ((lastMessage.parts ?? []) as ToolPart[]).filter(
    part =>
      (part.type?.startsWith("tool-") || part.type === "dynamic-tool") &&
      part.state === "input-available",
  );
  if (pendingParts.length === 0) return null;

  for (const part of pendingParts) {
    const toolName = toolNameOf(part);
    if (HUMAN_IN_THE_LOOP_TOOLS.has(toolName)) return null;
    const registered = (
      tools as Record<string, { execute?: unknown } | undefined>
    )[toolName];
    if (!registered || typeof registered.execute === "function") return null;
  }
  return { lastMessage, pendingParts };
}

/** `allMessages` with the pending parts answered by NO_CLIENT_TOOL_RESULT. */
export function patchStrandedToolParts(
  allMessages: UIMessage[],
  lastMessage: UIMessage,
  pendingParts: ToolPart[],
): UIMessage[] {
  const pendingSet = new Set(pendingParts);
  const patchedLast = {
    ...lastMessage,
    parts: (lastMessage.parts ?? []).map(part =>
      pendingSet.has(part as ToolPart)
        ? {
            ...part,
            state: "output-available" as const,
            output: NO_CLIENT_TOOL_RESULT,
          }
        : part,
    ),
  } as UIMessage;
  return [...allMessages.slice(0, -1), patchedLast];
}

/**
 * Returns true when a continuation segment was started (the caller must
 * then leave the resume pointer to the new segment).
 */
export async function maybeContinueStrandedTurn(input: {
  turn: ChatTurn;
  allMessages: UIMessage[];
  isAborted: boolean;
  continuationDepth: number;
  segmentStreamId: string | null;
  runSegment: (
    turn: ChatTurn,
    messages: UIMessage[],
    continuationDepth: number,
  ) => Promise<Response>;
}): Promise<boolean> {
  const { turn, allMessages, isAborted, continuationDepth } = input;
  const { chatId, workspaceId, actorId } = turn;
  const signal = turn.abort.signal;
  if (isAborted || signal.aborted) return false;
  if (continuationDepth >= MAX_NO_CLIENT_CONTINUATIONS) return false;

  const stranded = findStrandedClientToolParts(allMessages, turn.tools);
  if (!stranded) return false;

  // Grace period: a client that just refreshed gets a chance to reattach and
  // run the tools itself (the normal client-driven loop).
  await new Promise(resolve => setTimeout(resolve, STRANDED_GRACE_MS));
  if (signal.aborted) return false;
  if (await hasAttachedClients(workspaceId)) return false;

  // Confirm this segment still owns the turn (no newer turn or stop).
  const freshChat = await Chat.findById(chatId).select("activeStreamId");
  if (!freshChat || freshChat.activeStreamId !== input.segmentStreamId) {
    return false;
  }

  const patchedMessages = patchStrandedToolParts(
    allMessages,
    stranded.lastMessage,
    stranded.pendingParts,
  );

  try {
    await saveChat(chatId, workspaceId, actorId, patchedMessages);
  } catch (error) {
    logger.warn("Failed to persist synthesized tool results", {
      error,
      chatId,
    });
    return false;
  }

  logger.info("Continuing stranded turn without attached client", {
    chatId,
    continuationDepth: continuationDepth + 1,
    pendingTools: stranded.pendingParts.map(p =>
      p.type === "dynamic-tool" ? p.toolName : p.type.slice(5),
    ),
  });

  // The continuation Response has no HTTP consumer — drain its body so
  // nothing backs up; reattaching clients consume the resumable copy.
  const response = await input.runSegment(
    turn,
    patchedMessages,
    continuationDepth + 1,
  );
  if (response.body) {
    void response.body
      .pipeTo(
        new WritableStream({
          write() {
            /* discard */
          },
        }),
      )
      .catch(() => undefined);
  }
  return true;
}

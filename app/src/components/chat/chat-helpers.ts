import type { UIMessage } from "ai";
import { isToolPartType, toolNameFromPartType } from "./tool-presentation";

/** What the chat error banner shows for a stream/request error. */
export type ChatErrorDisplay =
  | {
      kind: "upgrade";
      errorCode: "usage_limit_exceeded" | "model_not_available";
      /** As sent by the server (parsed JSON, not validated). */
      message: string;
      plan?: string;
      currentUsageUsd?: number;
      quotaUsd?: number;
    }
  | { kind: "message"; message: string };

/**
 * Billing errors get an upgrade prompt; other structured server errors (model
 * auth / rate limit / stream failures) show their human-readable message
 * instead of the raw JSON envelope; anything else is shown as-is.
 */
export function describeChatError(errorMessage: string): ChatErrorDisplay {
  try {
    const parsed = JSON.parse(errorMessage);
    if (
      parsed.code === "usage_limit_exceeded" ||
      parsed.code === "model_not_available"
    ) {
      return {
        kind: "upgrade",
        errorCode: parsed.code,
        message: parsed.message,
        plan: parsed.plan,
        currentUsageUsd: parsed.currentUsageUsd,
        quotaUsd: parsed.quotaUsd,
      };
    }
    if (
      typeof parsed?.code === "string" &&
      typeof parsed?.message === "string"
    ) {
      return { kind: "message", message: parsed.message };
    }
  } catch {
    // not JSON, fall through to generic
  }
  return { kind: "message", message: errorMessage };
}

export interface PendingInteractiveTool {
  toolName: "ask_clarifying_questions" | "submit_plan";
  toolCallId: string;
  input: unknown;
  /** submit_plan whose input is still streaming. */
  streaming: boolean;
  /** Parked on the Local Agent's desktop bridge rather than in useChat. */
  viaAcpBridge: boolean;
}

/**
 * The deferred interactive tool call (clarifying questions / plan) the last
 * assistant message is waiting on, if any. submit_plan also counts while its
 * input is still streaming so the plan tab and dock card can render the plan
 * as the model writes it.
 */
export function findPendingInteractiveTool(
  lastMessage: Pick<UIMessage, "role" | "parts"> | undefined,
): PendingInteractiveTool | null {
  if (!lastMessage || lastMessage.role !== "assistant") return null;
  for (const part of (lastMessage.parts ?? []) as Array<
    Record<string, unknown>
  >) {
    const partType = part.type as string | undefined;
    const dynamicName =
      partType === "dynamic-tool" ? String(part.toolName || "") : "";
    const isClarify =
      partType === "tool-ask_clarifying_questions" ||
      dynamicName === "ask_clarifying_questions";
    const isPlan =
      partType === "tool-submit_plan" || dynamicName === "submit_plan";
    if (!isClarify && !isPlan) continue;
    const isStreamingPlan = isPlan && part.state === "input-streaming";
    if (part.state !== "input-available" && !isStreamingPlan) continue;
    return {
      toolName: isPlan ? "submit_plan" : "ask_clarifying_questions",
      toolCallId: (part.toolCallId as string) || "",
      input: part.input,
      streaming: isStreamingPlan,
      viaAcpBridge: false,
    };
  }
  return null;
}

/** The transcript as copied by "Copy chat history as JSON". */
export function serializeChatHistory(
  messages: Array<Pick<UIMessage, "id" | "role" | "parts">>,
) {
  return messages.map(msg => {
    const parts = (msg.parts || []).map(rawPart => {
      const part = rawPart as Record<string, unknown>;
      const partType = part.type as string;
      if (partType === "text") {
        return { type: "text", text: part.text };
      }
      if (partType === "reasoning") {
        return { type: "reasoning", text: part.text };
      }
      if (isToolPartType(partType)) {
        return {
          type: partType,
          toolCallId: part.toolCallId,
          toolName:
            partType === "dynamic-tool"
              ? part.toolName
              : toolNameFromPartType(partType),
          state: part.state,
          input: part.input,
          output: part.output,
        };
      }
      return { type: partType, ...part };
    });
    return { id: msg.id, role: msg.role, parts };
  });
}

const isSettledToolState = (state: unknown) =>
  state === "output-available" || state === "error";

/**
 * Aborting mid-stream can leave assistant tool calls stuck in
 * "input-available"/"input-streaming" (their output never arrives). The AI
 * SDK blocks the next sendMessage until every tool call is settled, so patch
 * any dangling ones to "error". Unchanged messages keep their identity.
 */
export function settleDanglingToolParts<M extends UIMessage>(
  messages: M[],
): M[] {
  return messages.map(msg => {
    if (msg.role !== "assistant") return msg;
    const isPending = (p: unknown) => {
      const part = p as Record<string, unknown>;
      return (
        isToolPartType(part.type as string) && !isSettledToolState(part.state)
      );
    };
    if (!msg.parts?.some(isPending)) return msg;
    return {
      ...msg,
      parts: msg.parts.map(p =>
        isPending(p)
          ? {
              ...p,
              state: "error" as const,
              output: {
                success: false,
                error: "Tool cancelled (chat stopped)",
              },
            }
          : p,
      ) as M["parts"],
    };
  });
}

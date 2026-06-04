/**
 * Dashboard version context
 *
 * Best-effort extraction of the chat prompts that drove changes to a given
 * dashboard. There is no persisted FK from a chat to a dashboard, so we scan
 * the user's recent chats for tool calls that reference the dashboard id and
 * collect the user prompts that immediately preceded those edits. This covers
 * AI-driven dashboard changes; purely manual edits simply yield no prompts and
 * the comment generator falls back to the diff alone.
 */

import { Types } from "mongoose";
import { Chat } from "../database/workspace-schema";
import { loggers } from "../logging";

const logger = loggers.app();

const MAX_CHATS_SCANNED = 15;
const MAX_PROMPTS = 6;

function extractTextFromParts(parts: unknown): string {
  if (!Array.isArray(parts)) return "";
  return parts
    .filter((p: any) => p && p.type === "text" && typeof p.text === "string")
    .map((p: any) => p.text as string)
    .join("");
}

function extractText(msg: any): string {
  if (typeof msg?.content === "string") return msg.content;
  if (Array.isArray(msg?.parts)) return extractTextFromParts(msg.parts);
  return "";
}

function extractToolInputs(msg: any): Array<Record<string, unknown>> {
  const inputs: Array<Record<string, unknown>> = [];

  if (Array.isArray(msg?.parts)) {
    for (const part of msg.parts) {
      if (!part || typeof part !== "object") continue;
      const type = (part as any).type as string | undefined;
      if (type === "tool-invocation" && (part as any).toolInvocation?.args) {
        inputs.push((part as any).toolInvocation.args);
      } else if (
        (typeof type === "string" && type.startsWith("tool-")) ||
        type === "dynamic-tool"
      ) {
        if ((part as any).input && typeof (part as any).input === "object") {
          inputs.push((part as any).input);
        }
      }
    }
  }

  if (Array.isArray(msg?.toolCalls)) {
    for (const tc of msg.toolCalls) {
      if (tc?.input && typeof tc.input === "object") {
        inputs.push(tc.input);
      }
    }
  }

  return inputs;
}

function messageTouchesDashboard(msg: any, dashboardId: string): boolean {
  for (const input of extractToolInputs(msg)) {
    if (
      typeof input.dashboardId === "string" &&
      input.dashboardId === dashboardId
    ) {
      return true;
    }
  }
  return false;
}

/**
 * Returns the most recent user prompts (oldest → newest) that triggered AI
 * edits to the given dashboard, across the user's recent chats. Best effort:
 * returns an empty array on any error or when no chat touched the dashboard.
 */
export async function getDashboardChatPrompts(
  workspaceId: string,
  userId: string,
  dashboardId: string,
): Promise<string[]> {
  if (!Types.ObjectId.isValid(workspaceId)) return [];

  try {
    const chats = await Chat.find(
      {
        workspaceId: new Types.ObjectId(workspaceId),
        createdBy: userId.toString(),
      },
      { messages: 1, updatedAt: 1 },
    )
      .sort({ updatedAt: -1 })
      .limit(MAX_CHATS_SCANNED)
      .lean();

    const prompts: string[] = [];

    for (const chat of chats) {
      const messages = Array.isArray((chat as any).messages)
        ? ((chat as any).messages as any[])
        : [];

      let lastUserPrompt: string | null = null;
      for (const msg of messages) {
        if (msg?.role === "user") {
          const text = extractText(msg).trim();
          if (text) lastUserPrompt = text;
        } else if (
          msg?.role === "assistant" &&
          messageTouchesDashboard(msg, dashboardId) &&
          lastUserPrompt
        ) {
          if (!prompts.includes(lastUserPrompt)) {
            prompts.push(lastUserPrompt);
          }
        }
      }
    }

    return prompts.slice(-MAX_PROMPTS);
  } catch (err) {
    logger.warn("Failed to gather dashboard chat prompts", {
      error: String(err),
      dashboardId,
    });
    return [];
  }
}

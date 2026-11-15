/**
 * Step 3 of a chat turn: load the chat document this turn belongs to, check
 * it may be continued by this agent, or create it on the first message.
 */
import { ObjectId } from "mongodb";
import type { UIMessage } from "ai";

import type { AgentContext } from "../../agents";
import { Chat } from "../../database/workspace-schema";
import { loggers } from "../../logging";
import { generateChatTitle } from "../title-generator";
import { stepFailure, type StepFailure } from "./request";

const logger = loggers.agent();

export async function loadOrCreateChat(input: {
  chatId: string;
  workspaceId: string;
  actorId: string;
  actorEmail: string | undefined;
  appChat: AgentContext["appChat"];
  messages: UIMessage[];
}): Promise<StepFailure | null> {
  const { chatId, workspaceId, actorId, actorEmail, appChat, messages } = input;
  const existingChat = await Chat.findById(chatId);

  // An app chat stays its viewer's, about its app, under its agent — the
  // closed agent must not be steered onto someone else's chat, and an app
  // chat must not be continued by an agent with workspace-wide tools.
  if (existingChat) {
    const boundAppId = existingChat.appId ?? null;
    if (appChat) {
      if (
        existingChat.workspaceId.toString() !== workspaceId ||
        existingChat.createdBy !== actorId ||
        boundAppId !== appChat.project._id.toString()
      ) {
        return stepFailure(403, "Cannot access chat");
      }
    } else if (boundAppId) {
      return stepFailure(
        400,
        "This chat belongs to an app; continue it from the app",
      );
    }
    return null;
  }

  if (messages.length === 0) return null;

  // Create the chat document now (awaited so it is persisted), then generate
  // the title fire-and-forget. IMPORTANT: title generation uses
  // generateText(), which would interfere with the main streamText() response
  // if awaited — keep the two streams separate.
  await Chat.create({
    _id: new ObjectId(chatId),
    workspaceId: new ObjectId(workspaceId),
    createdBy: actorId,
    ...(appChat ? { appId: appChat.project._id.toString() } : {}),
    title: "New Chat",
    titleGenerated: false,
    messages: [],
    createdAt: new Date(),
    updatedAt: new Date(),
  });

  const firstUserMessage = messages.find(m => m.role === "user");
  const userContent = firstUserMessage?.parts
    ? firstUserMessage.parts
        .filter((p): p is { type: "text"; text: string } => p.type === "text")
        .map(p => p.text)
        .join("")
    : "";

  if (userContent.length >= 3) {
    void (async () => {
      try {
        const title = await generateChatTitle(userContent, {
          workspaceId,
          userId: actorId,
          userEmail: actorEmail,
        });
        await Chat.updateOne(
          { _id: new ObjectId(chatId), titleGenerated: false },
          { title, titleGenerated: true },
        );
      } catch (err) {
        logger.error("Background title generation failed", { error: err });
      }
    })();
  }
  return null;
}

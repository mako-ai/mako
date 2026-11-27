/**
 * Step 3 of a chat turn: load the chat document this turn belongs to, check
 * it may be continued by this agent, or create it on the first message.
 */
import type { UIMessage } from "ai";

import type { AgentContext } from "../../agents";
import { parseEntityId } from "../../database/pg/id-codec";
import { loggers } from "../../logging";
import { chatRepo } from "../../repositories/chat";
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
  const existingChat = await chatRepo.findById(chatId);

  // An app chat stays its viewer's, about its app, under its agent — the
  // closed agent must not be steered onto someone else's chat, and an app
  // chat must not be continued by an agent with workspace-wide tools.
  // Also reject any cross-workspace chatId rather than falling through to
  // `create()` and crashing on duplicate PK.
  if (existingChat) {
    const existingWsOid =
      parseEntityId(existingChat.workspaceId)?.oid ?? existingChat.workspaceId;
    const requestedWsOid = parseEntityId(workspaceId)?.oid ?? workspaceId;
    if (existingWsOid !== requestedWsOid) {
      return stepFailure(403, "Cannot access chat");
    }
    const boundAppId = existingChat.appId ?? null;
    if (appChat) {
      if (boundAppId !== appChat.project._id.toString()) {
        return stepFailure(403, "Cannot access chat");
      }
      const ownerMatches =
        existingChat.createdBy !== null && existingChat.createdBy === actorId
          ? true
          : Boolean(
              (await chatRepo.findOwnershipMeta(workspaceId, chatId, actorId))
                ?.isOwnedByActor,
            );
      if (!ownerMatches) {
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

  const now = new Date();
  await chatRepo.create({
    id: chatId,
    workspaceId,
    createdBy: actorId,
    source: appChat ? "app" : "chat",
    appId: appChat ? appChat.project._id.toString() : null,
    title: "New Chat",
    titleGenerated: false,
    messages: [],
    createdAt: now,
    updatedAt: now,
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
        await chatRepo.setGeneratedTitleIfUnset(workspaceId, chatId, title);
      } catch (err) {
        logger.error("Background title generation failed", { error: err });
      }
    })();
  }
  return null;
}

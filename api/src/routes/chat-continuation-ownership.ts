import { ObjectId } from "mongodb";
import { Chat } from "../database/workspace-schema";

export interface ChatOwnershipScope {
  chatId: string;
  workspaceId: string;
  actorId: string;
}

function scopedChatQuery(scope: ChatOwnershipScope) {
  return {
    _id: new ObjectId(scope.chatId),
    workspaceId: new ObjectId(scope.workspaceId),
    createdBy: scope.actorId,
  };
}

export async function beginChatTurnOwnership(
  scope: ChatOwnershipScope,
  turnId: string,
): Promise<string | undefined> {
  const previous = await Chat.findOneAndUpdate(
    scopedChatQuery(scope),
    {
      $set: {
        activeTurnId: turnId,
        appsV2ActiveTurnId: turnId,
        activeStreamId: null,
        continuationGeneration: 0,
      },
    },
    { new: false },
  );
  return previous?.appsV2ActiveTurnId ?? undefined;
}

export async function getAppsV2TurnOwnership(
  scope: ChatOwnershipScope,
): Promise<string | null | undefined> {
  const chat = await Chat.findOne(scopedChatQuery(scope)).select(
    "appsV2ActiveTurnId",
  );
  return chat?.appsV2ActiveTurnId;
}

export async function promoteChatTurnOwnership(
  scope: ChatOwnershipScope,
  expectedAppsV2TurnId: string | null | undefined,
  turnId: string,
): Promise<boolean> {
  const result = await Chat.updateOne(
    {
      ...scopedChatQuery(scope),
      ...(expectedAppsV2TurnId
        ? { appsV2ActiveTurnId: expectedAppsV2TurnId }
        : {
            $or: [
              { appsV2ActiveTurnId: { $exists: false } },
              { appsV2ActiveTurnId: null },
            ],
          }),
    },
    {
      $set: {
        activeTurnId: turnId,
        appsV2ActiveTurnId: turnId,
        activeStreamId: null,
        continuationGeneration: 0,
      },
    },
  );
  return result.matchedCount === 1;
}

export async function assignChatSegmentStream(
  scope: ChatOwnershipScope,
  turnId: string,
  continuationGeneration: number,
  streamId: string,
): Promise<boolean> {
  const result = await Chat.updateOne(
    {
      ...scopedChatQuery(scope),
      activeTurnId: turnId,
      continuationGeneration,
    },
    { $set: { activeStreamId: streamId } },
  );
  return result.matchedCount === 1;
}

export async function claimChatContinuation(
  scope: ChatOwnershipScope,
  turnId: string,
  activeStreamId: string,
  continuationGeneration: number,
): Promise<boolean> {
  const result = await Chat.updateOne(
    {
      ...scopedChatQuery(scope),
      activeTurnId: turnId,
      activeStreamId,
      continuationGeneration,
    },
    {
      $inc: { continuationGeneration: 1 },
    },
  );
  return result.modifiedCount === 1;
}

export async function clearChatTurnOwnership(
  scope: ChatOwnershipScope,
  turnId: string,
  activeStreamId: string,
): Promise<boolean> {
  const result = await Chat.updateOne(
    {
      ...scopedChatQuery(scope),
      activeTurnId: turnId,
      activeStreamId,
    },
    {
      $set: { activeStreamId: null, activeTurnId: null },
    },
  );
  return result.modifiedCount === 1;
}

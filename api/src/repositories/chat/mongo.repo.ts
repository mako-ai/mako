/**
 * MongoDB (Mongoose) implementation of `ChatRepository`.
 *
 * Preserves the Mongo 16MB BSON-limit retry (`mongoBsonRetryMessages`) strictly
 * on the Mongo write path — Postgres never hits a 16MB document cap.
 */
import { randomUUID } from "node:crypto";
import { Types } from "mongoose";
import { Chat, ChatAttachment } from "../../database/models/chats";
import { parseEntityId } from "../../database/pg/id-codec";
import { loggers } from "../../logging";
import {
  buildChatListFilter,
  CHAT_LIST_PROJECTION,
  CHAT_LIST_SORT,
  encodeChatListCursor,
} from "./cursor";
import {
  mongoChatAttachmentToRecord,
  mongoChatToRecord,
  storedMessageToMongoDoc,
  type MongoChatAttachmentLike,
  type MongoChatLike,
} from "./mapper";
import type {
  AppChatListEntry,
  ChatAttachmentRecord,
  ChatListEntry,
  ChatLocalAcp,
  ChatRecord,
  ChatRepository,
  CreateChatAttachmentInput,
  CreateChatInput,
  SaveChatMessagesInput,
  StoredChatMessage,
  UpdateChatThreadPatch,
} from "./types";

const logger = loggers.agent();

function toObjectId(id: string | null | undefined): Types.ObjectId | null {
  if (!id) return null;
  const oid = parseEntityId(id)?.oid;
  return oid ? new Types.ObjectId(oid) : null;
}

function toWireOidString(id: string): string {
  return parseEntityId(id)?.oid ?? id;
}

export class MongoChatRepository implements ChatRepository {
  // ── Chat lifecycle & reads ───────────────────────────────────────────────

  async create(input: CreateChatInput): Promise<ChatRecord> {
    const wsOid = toObjectId(input.workspaceId);
    if (!wsOid) {
      throw new Error(
        `Invalid workspaceId: ${JSON.stringify(input.workspaceId)}`,
      );
    }
    const _id = input.id
      ? (toObjectId(input.id) ?? new Types.ObjectId())
      : new Types.ObjectId();
    const now = input.createdAt ?? new Date();
    const updatedAt = input.updatedAt ?? now;

    const docData: Record<string, unknown> = {
      _id,
      workspaceId: wsOid,
      createdBy: input.createdBy ?? "system",
      title: input.title ?? "New Chat",
      titleGenerated: input.titleGenerated ?? false,
      messages: (input.messages ?? []).map(storedMessageToMongoDoc),
      createdAt: now,
      updatedAt,
    };
    if (input.source === "workflow") docData.source = "workflow";
    if (input.appId) docData.appId = input.appId;
    if (input.threadId) docData.threadId = input.threadId;
    if (input.activeAgent) docData.activeAgent = input.activeAgent;
    if (input.pinnedConsoleId) docData.pinnedConsoleId = input.pinnedConsoleId;
    if (input.systemPrompt != null) docData.systemPrompt = input.systemPrompt;
    if (input.workspacePrompt != null) {
      docData.workspacePrompt = input.workspacePrompt;
    }

    const created = new Chat(docData);
    await created.save({ timestamps: false });
    return mongoChatToRecord(created.toObject() as unknown as MongoChatLike);
  }

  async findById(
    chatId: string,
    workspaceId?: string,
  ): Promise<ChatRecord | null> {
    const idOid = toObjectId(chatId);
    if (!idOid) return null;
    const filter: Record<string, unknown> = { _id: idOid };
    if (workspaceId !== undefined) {
      const wsOid = toObjectId(workspaceId);
      if (!wsOid) return null;
      filter.workspaceId = wsOid;
    }
    const doc = await Chat.findOne(filter).lean<MongoChatLike | null>();
    return doc ? mongoChatToRecord(doc) : null;
  }

  async findOwnedById(
    workspaceId: string,
    chatId: string,
    userId: string,
  ): Promise<ChatRecord | null> {
    const wsOid = toObjectId(workspaceId);
    const idOid = toObjectId(chatId);
    if (!wsOid || !idOid) return null;
    const doc = await Chat.findOne({
      _id: idOid,
      workspaceId: wsOid,
      createdBy: userId,
    }).lean<MongoChatLike | null>();
    return doc ? mongoChatToRecord(doc) : null;
  }

  async findOwnershipMeta(
    workspaceId: string,
    chatId: string,
  ): Promise<{ createdBy: string | null; titleGenerated: boolean } | null> {
    const wsOid = toObjectId(workspaceId);
    const idOid = toObjectId(chatId);
    if (!wsOid || !idOid) return null;
    const doc = await Chat.findOne({ _id: idOid, workspaceId: wsOid })
      .select({ createdBy: 1, titleGenerated: 1 })
      .lean<{ createdBy?: string; titleGenerated?: boolean } | null>();
    if (!doc) return null;
    const raw = doc.createdBy?.trim() ?? null;
    return {
      createdBy: !raw || raw === "system" ? null : raw,
      titleGenerated: Boolean(doc.titleGenerated),
    };
  }

  async listUserChats(input: {
    workspaceId: string;
    userId: string;
    limit: number;
    after?: { updatedAt: number | null; id: string } | null;
  }): Promise<{ chats: ChatListEntry[]; nextCursor: string | null }> {
    if (!toObjectId(input.workspaceId)) {
      return { chats: [], nextCursor: null };
    }
    if (input.after && !toObjectId(input.after.id)) {
      return { chats: [], nextCursor: null };
    }
    const docs = await Chat.find(
      buildChatListFilter({
        workspaceId: input.workspaceId,
        userId: input.userId,
        after: input.after ?? null,
      }),
      CHAT_LIST_PROJECTION,
    )
      .sort(CHAT_LIST_SORT)
      .limit(input.limit + 1)
      .lean<
        Array<{
          _id: Types.ObjectId;
          title?: string;
          createdAt?: Date;
          updatedAt?: Date | null;
          activeStreamId?: string | null;
          usage?: { totalTokens?: number; costUsd?: number };
        }>
      >();

    const page = docs.slice(0, input.limit);
    const last = page[page.length - 1];
    const nextCursor =
      docs.length > input.limit && last
        ? encodeChatListCursor({
            updatedAt: last.updatedAt ? last.updatedAt.getTime() : null,
            id: last._id.toString(),
          })
        : null;

    return {
      chats: page.map(doc => ({
        _id: doc._id.toString(),
        title: doc.title ?? "",
        createdAt: doc.createdAt,
        updatedAt: doc.updatedAt ?? undefined,
        activeStreamId: doc.activeStreamId ?? null,
        ...(doc.usage ? { usage: doc.usage } : {}),
      })),
      nextCursor,
    };
  }

  async listAppChats(
    workspaceId: string,
    appId: string,
    userId: string,
    limit = 50,
  ): Promise<AppChatListEntry[]> {
    const wsOid = toObjectId(workspaceId);
    if (!wsOid) return [];
    const docs = await Chat.find(
      { workspaceId: wsOid, appId, createdBy: userId },
      { title: 1, updatedAt: 1, createdAt: 1, activeStreamId: 1 },
    )
      .sort({ updatedAt: -1, _id: -1 })
      .limit(limit)
      .lean<
        Array<{
          _id: Types.ObjectId;
          title?: string;
          createdAt?: Date;
          updatedAt?: Date;
          activeStreamId?: string | null;
        }>
      >();

    return docs.map(chat => ({
      id: chat._id.toString(),
      title: chat.title ?? "New Chat",
      createdAt: chat.createdAt ?? new Date(0),
      updatedAt: chat.updatedAt ?? chat.createdAt ?? new Date(0),
      streaming: Boolean(chat.activeStreamId),
    }));
  }

  // ── Mutations ────────────────────────────────────────────────────────────

  async saveMessages(input: SaveChatMessagesInput): Promise<ChatRecord | null> {
    const idOid = toObjectId(input.chatId);
    const wsOid = toObjectId(input.workspaceId);
    if (!idOid || !wsOid) return null;

    const now = input.now ?? new Date();
    const storedDocs = input.messages.map(storedMessageToMongoDoc);

    const $set: Record<string, unknown> = {
      messages: storedDocs,
      updatedAt: now,
    };
    const $unset: Record<string, string> = {
      turnCheckpoint: "",
    };

    if (input.localAcp) {
      $set.localAcp = {
        providerId: input.localAcp.providerId,
        sessionId: input.localAcp.sessionId,
        modelId: input.localAcp.modelId,
      };
    } else {
      $unset.localAcp = "";
    }

    const updateOp: Record<string, unknown> = {
      $set,
      $unset,
      $setOnInsert: {
        workspaceId: wsOid,
        createdBy: input.userId ?? "system",
        title: "New Chat",
        titleGenerated: false,
        threadId: input.threadIdOnInsert ?? randomUUID(),
        createdAt: now,
      },
    };

    if (input.usage && input.usage.totalTokens > 0) {
      updateOp.$inc = {
        "usage.promptTokens": input.usage.promptTokens,
        "usage.completionTokens": input.usage.completionTokens,
        "usage.totalTokens": input.usage.totalTokens,
        "usage.cacheReadTokens": input.usage.cacheReadTokens ?? 0,
        "usage.cacheWriteTokens": input.usage.cacheWriteTokens ?? 0,
        "usage.reasoningTokens": input.usage.reasoningTokens ?? 0,
        "usage.costUsd": input.usage.costUsd ?? 0,
      };
      updateOp.$push = {
        "usage.history": {
          messageIndex: input.usage.assistantMessageIndex,
          promptTokens: input.usage.promptTokens,
          completionTokens: input.usage.completionTokens,
          totalTokens: input.usage.totalTokens,
          cacheReadTokens: input.usage.cacheReadTokens ?? 0,
          cacheWriteTokens: input.usage.cacheWriteTokens ?? 0,
          reasoningTokens: input.usage.reasoningTokens ?? 0,
          costUsd: input.usage.costUsd ?? 0,
          model: input.usage.model,
          timestamp: now,
        },
      };
    }

    let result: MongoChatLike | null;
    try {
      result = await Chat.findOneAndUpdate({ _id: idOid }, updateOp, {
        upsert: true,
        returnDocument: "after",
        timestamps: false,
      }).lean<MongoChatLike | null>();
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (
        !input.mongoBsonRetryMessages ||
        !/BSON|too large|larger than/i.test(msg)
      ) {
        throw error;
      }
      logger.error(
        "Chat save exceeded BSON limit; retrying with stripped tool outputs",
        { chatId: input.chatId, error: msg },
      );
      (updateOp.$set as Record<string, unknown>).messages =
        input.mongoBsonRetryMessages.map(storedMessageToMongoDoc);
      result = await Chat.findOneAndUpdate({ _id: idOid }, updateOp, {
        upsert: true,
        returnDocument: "after",
        timestamps: false,
      }).lean<MongoChatLike | null>();
    }

    return result ? mongoChatToRecord(result) : null;
  }

  /**
   * Full-document repack upsert used for Stage 4 PG->Mongo reverse sync and
   * dead-letter sync-retry so instant Stage 4->2 rollback loses zero data.
   */
  async upsertFullRecord(
    record: ChatRecord,
    mongoBsonRetryMessages?: StoredChatMessage[],
  ): Promise<void> {
    const idOid = toObjectId(record.id);
    const wsOid = toObjectId(record.workspaceId);
    if (!idOid || !wsOid) return;

    const buildSet = (msgs: StoredChatMessage[]) => {
      const $set: Record<string, unknown> = {
        workspaceId: wsOid,
        createdBy: record.createdBy ?? "system",
        title: record.title,
        titleGenerated: record.titleGenerated,
        activeStreamId: record.activeStreamId,
        activeStreamAliveAt: record.activeStreamAliveAt,
        turnCheckpoint: record.turnCheckpoint,
        messages: msgs.map(storedMessageToMongoDoc),
        usage: {
          promptTokens: record.usage.promptTokens,
          completionTokens: record.usage.completionTokens,
          totalTokens: record.usage.totalTokens,
          cacheReadTokens: record.usage.cacheReadTokens,
          cacheWriteTokens: record.usage.cacheWriteTokens,
          reasoningTokens: record.usage.reasoningTokens,
          costUsd: record.usage.costUsd,
          history: record.usage.history.map(h => ({
            messageIndex: h.messageIndex,
            promptTokens: h.promptTokens,
            completionTokens: h.completionTokens,
            totalTokens: h.totalTokens,
            cacheReadTokens: h.cacheReadTokens,
            cacheWriteTokens: h.cacheWriteTokens,
            reasoningTokens: h.reasoningTokens,
            costUsd: h.costUsd,
            ...(h.model != null ? { model: h.model } : {}),
            timestamp: h.timestamp,
          })),
        },
        updatedAt: record.updatedAt,
      };
      const $unset: Record<string, string> = {};
      if (record.source === "workflow") $set.source = "workflow";
      else $unset.source = "";
      if (record.appId !== null) $set.appId = record.appId;
      else $unset.appId = "";
      if (record.threadId !== null) $set.threadId = record.threadId;
      else $unset.threadId = "";
      if (record.activeAgent !== null) $set.activeAgent = record.activeAgent;
      else $unset.activeAgent = "";
      if (record.pinnedConsoleId !== null) {
        $set.pinnedConsoleId = record.pinnedConsoleId;
      } else {
        $unset.pinnedConsoleId = "";
      }
      if (record.localAcp !== null) $set.localAcp = record.localAcp;
      else $unset.localAcp = "";
      if (record.systemPrompt !== null) $set.systemPrompt = record.systemPrompt;
      else $unset.systemPrompt = "";
      if (record.workspacePrompt !== null) {
        $set.workspacePrompt = record.workspacePrompt;
      } else {
        $unset.workspacePrompt = "";
      }

      const update: Record<string, unknown> = {
        $set,
        $setOnInsert: { createdAt: record.createdAt },
      };
      if (Object.keys($unset).length > 0) update.$unset = $unset;
      return update;
    };

    try {
      await Chat.updateOne({ _id: idOid }, buildSet(record.messages), {
        upsert: true,
        timestamps: false,
      });
    } catch (error) {
      const msg = error instanceof Error ? error.message : String(error);
      if (!mongoBsonRetryMessages || !/BSON|too large|larger than/i.test(msg)) {
        throw error;
      }
      await Chat.updateOne({ _id: idOid }, buildSet(mongoBsonRetryMessages), {
        upsert: true,
        timestamps: false,
      });
    }
  }

  async updateThreadFields(
    chatId: string,
    workspaceId: string | undefined,
    patch: UpdateChatThreadPatch,
  ): Promise<ChatRecord | null> {
    const idOid = toObjectId(chatId);
    if (!idOid) return null;
    const filter: Record<string, unknown> = { _id: idOid };
    if (workspaceId !== undefined) {
      const wsOid = toObjectId(workspaceId);
      if (!wsOid) return null;
      filter.workspaceId = wsOid;
    }

    const $set: Record<string, unknown> = {
      updatedAt: patch.updatedAt ?? new Date(),
    };
    if (patch.messages !== undefined) {
      $set.messages = patch.messages.map(storedMessageToMongoDoc);
    }
    if (patch.threadId !== undefined) $set.threadId = patch.threadId;
    if (patch.activeAgent !== undefined) $set.activeAgent = patch.activeAgent;
    if (patch.pinnedConsoleId !== undefined) {
      $set.pinnedConsoleId = patch.pinnedConsoleId;
    }
    if (patch.systemPrompt !== undefined) {
      $set.systemPrompt = patch.systemPrompt;
    }
    if (patch.workspacePrompt !== undefined) {
      $set.workspacePrompt = patch.workspacePrompt;
    }

    const updated = await Chat.findOneAndUpdate(
      filter,
      { $set },
      { returnDocument: "after", timestamps: false },
    ).lean<MongoChatLike | null>();
    return updated ? mongoChatToRecord(updated) : null;
  }

  async updateLocalAcp(
    workspaceId: string,
    chatId: string,
    userId: string,
    localAcp: ChatLocalAcp | null,
  ): Promise<boolean> {
    const wsOid = toObjectId(workspaceId);
    const idOid = toObjectId(chatId);
    if (!wsOid || !idOid) return false;
    const update = localAcp
      ? {
          $set: {
            localAcp: {
              providerId: localAcp.providerId,
              sessionId: localAcp.sessionId,
              modelId: localAcp.modelId,
            },
          },
        }
      : { $unset: { localAcp: "" } };
    const res = await Chat.updateOne(
      { _id: idOid, workspaceId: wsOid, createdBy: userId },
      update,
      { timestamps: false },
    );
    return res.matchedCount > 0;
  }

  async updateTitle(
    workspaceId: string,
    chatId: string,
    userId: string,
    title: string,
    now: Date = new Date(),
  ): Promise<boolean> {
    const wsOid = toObjectId(workspaceId);
    const idOid = toObjectId(chatId);
    if (!wsOid || !idOid) return false;
    const updated = await Chat.findOneAndUpdate(
      { _id: idOid, workspaceId: wsOid, createdBy: userId },
      { $set: { title, updatedAt: now } },
      { returnDocument: "after", timestamps: false },
    )
      .select("_id")
      .lean();
    return Boolean(updated);
  }

  async setGeneratedTitleIfUnset(
    workspaceId: string,
    chatId: string,
    title: string,
  ): Promise<boolean> {
    const wsOid = toObjectId(workspaceId);
    const idOid = toObjectId(chatId);
    if (!wsOid || !idOid) return false;
    const res = await Chat.updateOne(
      { _id: idOid, workspaceId: wsOid, titleGenerated: false },
      { $set: { title, titleGenerated: true } },
      { timestamps: false },
    );
    return res.modifiedCount > 0;
  }

  async deleteOwned(
    workspaceId: string,
    chatId: string,
    userId: string,
  ): Promise<{ deleted: boolean; deletedAttachmentKeys: string[] }> {
    const wsOid = toObjectId(workspaceId);
    const idOid = toObjectId(chatId);
    if (!wsOid || !idOid) {
      return { deleted: false, deletedAttachmentKeys: [] };
    }
    const deletedChat = await Chat.findOneAndDelete({
      _id: idOid,
      workspaceId: wsOid,
      createdBy: userId,
    })
      .select("_id")
      .lean();
    if (!deletedChat) {
      return { deleted: false, deletedAttachmentKeys: [] };
    }

    const chatWireId = toWireOidString(chatId);
    const attachments = await ChatAttachment.find({
      workspaceId: wsOid,
      chatId: chatWireId,
    })
      .select("storageKey")
      .lean<Array<{ storageKey: string }>>();
    const deletedAttachmentKeys = attachments.map(a => a.storageKey);
    if (deletedAttachmentKeys.length > 0) {
      await ChatAttachment.deleteMany({
        workspaceId: wsOid,
        chatId: chatWireId,
      });
    }
    return { deleted: true, deletedAttachmentKeys };
  }

  // ── Streaming & checkpointing ────────────────────────────────────────────

  async getStreamState(
    chatId: string,
    workspaceId?: string,
  ): Promise<{
    workspaceId: string;
    activeStreamId: string | null;
    activeStreamAliveAt: Date | null;
  } | null> {
    const idOid = toObjectId(chatId);
    if (!idOid) return null;
    const filter: Record<string, unknown> = { _id: idOid };
    if (workspaceId !== undefined) {
      const wsOid = toObjectId(workspaceId);
      if (!wsOid) return null;
      filter.workspaceId = wsOid;
    }
    const doc = await Chat.findOne(filter)
      .select("workspaceId activeStreamId activeStreamAliveAt")
      .lean<{
        workspaceId: Types.ObjectId;
        activeStreamId?: string | null;
        activeStreamAliveAt?: Date | null;
      } | null>();
    if (!doc) return null;
    return {
      workspaceId: doc.workspaceId.toHexString(),
      activeStreamId: doc.activeStreamId ?? null,
      activeStreamAliveAt: doc.activeStreamAliveAt ?? null,
    };
  }

  async setActiveStream(
    workspaceId: string,
    chatId: string,
    streamId: string,
    now: Date = new Date(),
  ): Promise<void> {
    const idOid = toObjectId(chatId);
    const wsOid = toObjectId(workspaceId);
    if (!idOid || !wsOid) return;
    await Chat.updateOne(
      { _id: idOid, workspaceId: wsOid },
      { $set: { activeStreamId: streamId, activeStreamAliveAt: now } },
      { timestamps: false },
    );
  }

  async clearActiveStreamIfMatch(
    workspaceId: string,
    chatId: string,
    streamId: string,
  ): Promise<void> {
    const idOid = toObjectId(chatId);
    const wsOid = toObjectId(workspaceId);
    if (!idOid || !wsOid) return;
    await Chat.updateOne(
      { _id: idOid, workspaceId: wsOid, activeStreamId: streamId },
      { $set: { activeStreamId: null, activeStreamAliveAt: null } },
      { timestamps: false },
    );
  }

  async clearActiveStream(workspaceId: string, chatId: string): Promise<void> {
    const idOid = toObjectId(chatId);
    const wsOid = toObjectId(workspaceId);
    if (!idOid || !wsOid) return;
    await Chat.updateOne(
      { _id: idOid, workspaceId: wsOid },
      { $set: { activeStreamId: null, activeStreamAliveAt: null } },
      { timestamps: false },
    );
  }

  async saveTurnCheckpoint(
    workspaceId: string | undefined,
    chatId: string,
    streamId: string,
    message: StoredChatMessage,
    now: Date = new Date(),
  ): Promise<void> {
    const idOid = toObjectId(chatId);
    if (!idOid) return;
    const filter: Record<string, unknown> = {
      _id: idOid,
      activeStreamId: streamId,
    };
    if (workspaceId !== undefined) {
      const wsOid = toObjectId(workspaceId);
      if (!wsOid) return;
      filter.workspaceId = wsOid;
    }
    await Chat.updateOne(
      filter,
      {
        $set: {
          activeStreamAliveAt: now,
          turnCheckpoint: {
            message: storedMessageToMongoDoc(message),
            at: now,
            streamId,
          },
        },
      },
      { timestamps: false },
    );
  }

  // ── Attachments ──────────────────────────────────────────────────────────

  async findAttachmentByHash(
    workspaceId: string,
    chatId: string,
    sha256: string,
  ): Promise<ChatAttachmentRecord | null> {
    const wsOid = toObjectId(workspaceId);
    if (!wsOid) return null;
    const chatWireId = toWireOidString(chatId);
    const doc = await ChatAttachment.findOne({
      workspaceId: wsOid,
      chatId: chatWireId,
      sha256,
    }).lean<MongoChatAttachmentLike | null>();
    return doc ? mongoChatAttachmentToRecord(doc) : null;
  }

  async createAttachmentIdempotent(
    input: CreateChatAttachmentInput,
  ): Promise<ChatAttachmentRecord> {
    const wsOid = toObjectId(input.workspaceId);
    if (!wsOid) {
      throw new Error(
        `Invalid workspaceId: ${JSON.stringify(input.workspaceId)}`,
      );
    }
    const chatWireId = toWireOidString(input.chatId);
    const existing = await this.findAttachmentByHash(
      input.workspaceId,
      chatWireId,
      input.sha256,
    );
    if (existing) return existing;

    const _id = input.id
      ? (toObjectId(input.id) ?? new Types.ObjectId())
      : new Types.ObjectId();
    const now = input.createdAt ?? new Date();
    try {
      const created = new ChatAttachment({
        _id,
        workspaceId: wsOid,
        chatId: chatWireId,
        createdBy: input.createdBy ?? "system",
        storageKey: input.storageKey,
        mediaType: input.mediaType,
        ...(input.filename != null ? { filename: input.filename } : {}),
        size: input.size,
        sha256: input.sha256,
        createdAt: now,
        updatedAt: input.updatedAt ?? now,
      });
      await created.save({ timestamps: false });
      return mongoChatAttachmentToRecord(
        created.toObject() as unknown as MongoChatAttachmentLike,
      );
    } catch (error) {
      if ((error as { code?: number }).code === 11000) {
        const raced = await this.findAttachmentByHash(
          input.workspaceId,
          chatWireId,
          input.sha256,
        );
        if (raced) return raced;
      }
      throw error;
    }
  }

  async findAttachmentById(
    workspaceId: string,
    attachmentId: string,
  ): Promise<ChatAttachmentRecord | null> {
    const wsOid = toObjectId(workspaceId);
    const idOid = toObjectId(attachmentId);
    if (!wsOid || !idOid) return null;
    const doc = await ChatAttachment.findOne({
      _id: idOid,
      workspaceId: wsOid,
    }).lean<MongoChatAttachmentLike | null>();
    return doc ? mongoChatAttachmentToRecord(doc) : null;
  }

  async findAttachmentForUser(
    workspaceId: string,
    attachmentId: string,
    userId: string,
  ): Promise<ChatAttachmentRecord | null> {
    const wsOid = toObjectId(workspaceId);
    const idOid = toObjectId(attachmentId);
    if (!wsOid || !idOid) return null;
    const doc = await ChatAttachment.findOne({
      _id: idOid,
      workspaceId: wsOid,
      createdBy: userId,
    }).lean<MongoChatAttachmentLike | null>();
    return doc ? mongoChatAttachmentToRecord(doc) : null;
  }
}

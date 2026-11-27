/**
 * Normalized Chat domain repository entry point (Neon Postgres `pg_only`).
 */
import { PgChatRepository } from "./pg.repo";
import type { ChatRepository } from "./types";

export * from "./types";
export * from "./cursor";
export * from "./mapper";
export { PgChatRepository } from "./pg.repo";

const defaultChatRepo: ChatRepository = new PgChatRepository();
let activeChatRepo: ChatRepository = defaultChatRepo;

export function getChatRepo(): ChatRepository {
  return activeChatRepo;
}

export function setChatRepoForTests(repo: ChatRepository): void {
  activeChatRepo = repo;
}

export function resetChatRepoForTests(): void {
  activeChatRepo = defaultChatRepo;
}

export const chatRepo: ChatRepository = {
  create: input => activeChatRepo.create(input),
  ensureExists: input => activeChatRepo.ensureExists(input),
  findById: (chatId, workspaceId) =>
    activeChatRepo.findById(chatId, workspaceId),
  findOwnedById: (workspaceId, chatId, userId) =>
    activeChatRepo.findOwnedById(workspaceId, chatId, userId),
  findOwnershipMeta: (workspaceId, chatId, actorUserId) =>
    activeChatRepo.findOwnershipMeta(workspaceId, chatId, actorUserId),
  listUserChats: input => activeChatRepo.listUserChats(input),
  listAppChats: (workspaceId, appId, userId, limit) =>
    activeChatRepo.listAppChats(workspaceId, appId, userId, limit),

  saveMessages: input => activeChatRepo.saveMessages(input),
  updateThreadFields: (chatId, workspaceId, patch) =>
    activeChatRepo.updateThreadFields(chatId, workspaceId, patch),
  updateLocalAcp: (workspaceId, chatId, userId, localAcp) =>
    activeChatRepo.updateLocalAcp(workspaceId, chatId, userId, localAcp),
  updateTitle: (workspaceId, chatId, userId, title, now) =>
    activeChatRepo.updateTitle(workspaceId, chatId, userId, title, now),
  setGeneratedTitleIfUnset: (workspaceId, chatId, title) =>
    activeChatRepo.setGeneratedTitleIfUnset(workspaceId, chatId, title),
  deleteOwned: (workspaceId, chatId, userId) =>
    activeChatRepo.deleteOwned(workspaceId, chatId, userId),

  getStreamState: (chatId, workspaceId) =>
    activeChatRepo.getStreamState(chatId, workspaceId),
  setActiveStream: (workspaceId, chatId, streamId, now) =>
    activeChatRepo.setActiveStream(workspaceId, chatId, streamId, now),
  clearActiveStreamIfMatch: (workspaceId, chatId, streamId) =>
    activeChatRepo.clearActiveStreamIfMatch(workspaceId, chatId, streamId),
  clearActiveStream: (workspaceId, chatId) =>
    activeChatRepo.clearActiveStream(workspaceId, chatId),
  saveTurnCheckpoint: (workspaceId, chatId, streamId, message, now) =>
    activeChatRepo.saveTurnCheckpoint(
      workspaceId,
      chatId,
      streamId,
      message,
      now,
    ),

  findAttachmentByHash: (workspaceId, chatId, sha256) =>
    activeChatRepo.findAttachmentByHash(workspaceId, chatId, sha256),
  createAttachmentIdempotent: input =>
    activeChatRepo.createAttachmentIdempotent(input),
  findAttachmentById: (workspaceId, attachmentId) =>
    activeChatRepo.findAttachmentById(workspaceId, attachmentId),
  findAttachmentForUser: (workspaceId, attachmentId, userId) =>
    activeChatRepo.findAttachmentForUser(workspaceId, attachmentId, userId),
};

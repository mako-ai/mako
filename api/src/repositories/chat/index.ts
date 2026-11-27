/**
 * Normalized Chat domain repository entry point (`domain = "chat"`).
 *
 * Defaults to `mongo_only` until `migration_domain_state` advances `chat`
 * (globally or per workspace).
 */
import { DualChatRepository } from "./dual.repo";
import type { ChatRepository } from "./types";

export * from "./types";
export * from "./cursor";
export * from "./mapper";
export { MongoChatRepository } from "./mongo.repo";
export { PgChatRepository } from "./pg.repo";
export {
  CHAT_DOMAIN,
  CHAT_SHADOW_OPTIONS,
  DualChatRepository,
  type DualChatRepositoryDeps,
} from "./dual.repo";

const defaultChatRepo: ChatRepository = new DualChatRepository();
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
  findById: (chatId, workspaceId) =>
    activeChatRepo.findById(chatId, workspaceId),
  findOwnedById: (workspaceId, chatId, userId) =>
    activeChatRepo.findOwnedById(workspaceId, chatId, userId),
  findOwnershipMeta: (workspaceId, chatId) =>
    activeChatRepo.findOwnershipMeta(workspaceId, chatId),
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

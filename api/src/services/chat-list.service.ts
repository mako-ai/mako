/**
 * A user's chat history list (GET /api/workspaces/:wid/chats), one page at a
 * time.
 *
 * Keyset pagination on `(updatedAt desc, id desc)`: the `id` tie-break
 * makes the order total, so chats sharing an `updatedAt` are neither skipped
 * nor repeated across pages. Delegated through `chatRepo` (`domain = "chat"`).
 */
import {
  chatRepo,
  clampChatListLimit,
  decodeChatListCursor,
  type ChatListEntry,
} from "../repositories/chat";

export {
  buildChatListFilter,
  CHAT_LIST_DEFAULT_LIMIT,
  CHAT_LIST_MAX_LIMIT,
  CHAT_LIST_PROJECTION,
  CHAT_LIST_SORT,
  ChatListCursorError,
  clampChatListLimit,
  decodeChatListCursor,
  encodeChatListCursor,
  type ChatListCursorPosition,
} from "../repositories/chat/cursor";

export type { ChatListEntry } from "../repositories/chat";

export interface ChatListPage {
  chats: ChatListEntry[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

export async function listUserChats(args: {
  workspaceId: string;
  userId: string;
  limit?: number;
  cursor?: string | null;
}): Promise<ChatListPage> {
  const limit = clampChatListLimit(args.limit);
  const after = args.cursor ? decodeChatListCursor(args.cursor) : null;
  return chatRepo.listUserChats({
    workspaceId: args.workspaceId,
    userId: args.userId,
    limit,
    after,
  });
}

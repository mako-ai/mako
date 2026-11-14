/**
 * A user's chat history list (GET /api/workspaces/:wid/chats), one page at a
 * time.
 *
 * Keyset pagination on `(updatedAt desc, _id desc)`: the `_id` tie-break
 * makes the order total, so chats sharing an `updatedAt` are neither skipped
 * nor repeated across pages. The sort is served by the
 * `{ workspaceId, createdBy, updatedAt: -1, _id: -1 }` index, and only the
 * fields the history menu renders are read — never `messages`,
 * `turnCheckpoint`, `usage.history` or the stored prompts.
 */
import { Types } from "mongoose";
import { Chat } from "../database/workspace-schema";

export const CHAT_LIST_DEFAULT_LIMIT = 30;
export const CHAT_LIST_MAX_LIMIT = 100;

/** Fields a list entry carries — what the chat history menu renders. */
export const CHAT_LIST_PROJECTION = {
  _id: 1,
  title: 1,
  createdAt: 1,
  updatedAt: 1,
  activeStreamId: 1,
  "usage.totalTokens": 1,
  "usage.costUsd": 1,
} as const;

/** The sort the list index serves; `_id` makes it a total order. */
export const CHAT_LIST_SORT = { updatedAt: -1, _id: -1 } as const;

export interface ChatListEntry {
  _id: string;
  title: string;
  createdAt?: Date;
  updatedAt?: Date;
  activeStreamId?: string | null;
  usage?: { totalTokens?: number; costUsd?: number };
}

export interface ChatListPage {
  chats: ChatListEntry[];
  /** Pass back as `cursor` for the next page; null on the last page. */
  nextCursor: string | null;
}

/** A cursor the server did not mint (or can no longer read). */
export class ChatListCursorError extends Error {
  readonly status = 400 as const;
  constructor() {
    super("Invalid cursor");
    this.name = "ChatListCursorError";
  }
}

interface CursorPosition {
  /** `updatedAt` in epoch ms; null for a (legacy) chat without one. */
  updatedAt: number | null;
  id: string;
}

/** Opaque to clients: base64url JSON of the last entry's sort key. */
export function encodeChatListCursor(position: CursorPosition): string {
  return Buffer.from(
    JSON.stringify({ u: position.updatedAt, i: position.id }),
    "utf8",
  ).toString("base64url");
}

export function decodeChatListCursor(cursor: string): CursorPosition {
  let parsed: unknown;
  try {
    parsed = JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"));
  } catch {
    throw new ChatListCursorError();
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ChatListCursorError();
  }
  const { u, i } = parsed as { u?: unknown; i?: unknown };
  const validTime =
    u === null || (typeof u === "number" && Number.isFinite(u) && u >= 0);
  if (!validTime || typeof i !== "string" || !/^[0-9a-f]{24}$/.test(i)) {
    throw new ChatListCursorError();
  }
  return { updatedAt: u as number | null, id: i };
}

/** Clamp a requested page size into `[1, CHAT_LIST_MAX_LIMIT]`. */
export function clampChatListLimit(limit: number | undefined): number {
  if (limit === undefined || !Number.isFinite(limit)) {
    return CHAT_LIST_DEFAULT_LIMIT;
  }
  return Math.min(CHAT_LIST_MAX_LIMIT, Math.max(1, Math.floor(limit)));
}

/**
 * The Mongo filter for one page. Privacy scoping is unchanged from the
 * unpaginated list: the caller's own chats in this workspace, minus app chats
 * (listed in their app) and workflow-step runs (opened from their run).
 */
export function buildChatListFilter(args: {
  workspaceId: string;
  userId: string;
  after?: CursorPosition | null;
}): Record<string, unknown> {
  const filter: Record<string, unknown> = {
    workspaceId: new Types.ObjectId(args.workspaceId),
    createdBy: args.userId,
    appId: { $exists: false },
    source: { $ne: "workflow" },
  };
  const after = args.after;
  if (after) {
    const id = new Types.ObjectId(after.id);
    if (after.updatedAt === null) {
      // Undated chats sort last; only the rest of them remain.
      filter.updatedAt = null;
      filter._id = { $lt: id };
    } else {
      const at = new Date(after.updatedAt);
      filter.$or = [
        { updatedAt: { $lt: at } },
        { updatedAt: at, _id: { $lt: id } },
        // Range operators never match a missing field, and undated chats
        // sort after every dated one.
        { updatedAt: null },
      ];
    }
  }
  return filter;
}

export async function listUserChats(args: {
  workspaceId: string;
  userId: string;
  limit?: number;
  cursor?: string | null;
}): Promise<ChatListPage> {
  const limit = clampChatListLimit(args.limit);
  const after = args.cursor ? decodeChatListCursor(args.cursor) : null;
  const docs = await Chat.find(
    buildChatListFilter({
      workspaceId: args.workspaceId,
      userId: args.userId,
      after,
    }),
    CHAT_LIST_PROJECTION,
  )
    .sort(CHAT_LIST_SORT)
    .limit(limit + 1)
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

  const page = docs.slice(0, limit);
  const last = page[page.length - 1];
  const nextCursor =
    docs.length > limit && last
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

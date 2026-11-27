/**
 * Keyset pagination cursor encoding/decoding and Mongo filter helpers for
 * user chat history lists (`GET /api/workspaces/:wid/chats`).
 *
 * Kept dependency-free so both `MongoChatRepository`, `PgChatRepository`, and
 * `chat-list.service.ts` share one canonical cursor contract with zero cycles.
 */
import { Types } from "mongoose";
import {
  isObjectIdHex,
  isUuidString,
  parseEntityId,
} from "../../database/pg/id-codec";

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

/** A cursor the server did not mint (or can no longer read). */
export class ChatListCursorError extends Error {
  readonly status = 400 as const;
  constructor() {
    super("Invalid cursor");
    this.name = "ChatListCursorError";
  }
}

export interface ChatListCursorPosition {
  /** `updatedAt` in epoch ms; null for a (legacy) chat without one. */
  updatedAt: number | null;
  id: string;
}

/** Opaque to clients: base64url JSON of the last entry's sort key. */
export function encodeChatListCursor(position: ChatListCursorPosition): string {
  return Buffer.from(
    JSON.stringify({ u: position.updatedAt, i: position.id }),
    "utf8",
  ).toString("base64url");
}

export function decodeChatListCursor(cursor: string): ChatListCursorPosition {
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
  const validId =
    typeof i === "string" &&
    ((isObjectIdHex(i) && i === i.toLowerCase()) || isUuidString(i));
  if (!validTime || !validId) {
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
 * The Mongo filter for one page. Privacy scoping: the caller's own chats in
 * this workspace, minus app chats and workflow-step runs.
 */
export function buildChatListFilter(args: {
  workspaceId: string;
  userId: string;
  after?: ChatListCursorPosition | null;
}): Record<string, unknown> {
  const wsOid = parseEntityId(args.workspaceId)?.oid ?? args.workspaceId;
  const filter: Record<string, unknown> = {
    workspaceId: new Types.ObjectId(wsOid),
    createdBy: args.userId,
    appId: { $exists: false },
    source: { $ne: "workflow" },
  };
  const after = args.after;
  if (after) {
    const afterOid = parseEntityId(after.id)?.oid ?? after.id;
    const id = new Types.ObjectId(afterOid);
    if (after.updatedAt === null) {
      filter.updatedAt = null;
      filter._id = { $lt: id };
    } else {
      const at = new Date(after.updatedAt);
      filter.$or = [
        { updatedAt: { $lt: at } },
        { updatedAt: at, _id: { $lt: id } },
        { updatedAt: null },
      ];
    }
  }
  return filter;
}

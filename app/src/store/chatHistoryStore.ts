/**
 * The Chat panel's history list (the history menu in the chat header): the
 * caller's own chats in the current workspace, newest first, loaded a page at
 * a time from GET /api/workspaces/:wid/chats (keyset cursor).
 *
 * - `refresh` re-reads the FIRST page and merges it in (dedupe by id), so a
 *   chat created or updated in this session moves to the top without
 *   throwing away the deeper pages already scrolled into.
 * - `loadMore` appends the next page; one at a time (in-flight guard).
 * - Responses for a workspace the list no longer shows are dropped (epoch
 *   guard), and an older `refresh` never overwrites a newer one.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api } from "../api/client";

/** Rolled-up spend for a chat, as the list endpoint returns it. */
export interface ChatSessionUsage {
  totalTokens?: number;
  costUsd?: number;
}

export interface ChatSessionMeta {
  _id: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  /** Resume pointer set while a turn is generating server-side. */
  activeStreamId?: string | null;
  /** Per-chat token/cost roll-up (only the totals ride on the list). */
  usage?: ChatSessionUsage;
}

/** Page size the history menu asks for. */
export const CHAT_HISTORY_PAGE_SIZE = 30;

interface ChatHistoryState {
  /** Workspace the list belongs to; null before the first refresh. */
  workspaceId: string | null;
  sessions: ChatSessionMeta[];
  /** Cursor for the page after the deepest one loaded; null = no more. */
  nextCursor: string | null;
  /** True once the first page for this workspace has landed. */
  loaded: boolean;
  loadingFirst: boolean;
  loadingMore: boolean;
  /** Re-read the first page for `workspaceId` (switching resets the list). */
  refresh: (workspaceId: string) => Promise<void>;
  /** Append the next page; a no-op while one is in flight or at the end. */
  loadMore: () => Promise<void>;
  /** Delete server-side; resolves true on success. */
  deleteSession: (workspaceId: string, id: string) => Promise<boolean>;
  reset: () => void;
}

/**
 * Bumped whenever the list is reset (workspace switch, `reset`): a response
 * for an older epoch belongs to a list no longer on screen.
 */
let epoch = 0;
/** Latest refresh issued — older refresh responses are dropped. */
let refreshSeq = 0;

function toTime(session: ChatSessionMeta): number {
  const raw = session.updatedAt ?? session.createdAt;
  const ms = raw ? new Date(raw).getTime() : NaN;
  return Number.isFinite(ms) ? ms : -Infinity;
}

/** Server order: updatedAt desc, then _id desc (ObjectId hex sorts by age). */
export function compareSessions(a: ChatSessionMeta, b: ChatSessionMeta) {
  const byTime = toTime(b) - toTime(a);
  if (byTime !== 0 && !Number.isNaN(byTime)) return byTime;
  return a._id < b._id ? 1 : a._id > b._id ? -1 : 0;
}

/**
 * Merge `incoming` into `current`, deduped by id (incoming wins: it is the
 * fresher read), in server order.
 */
export function mergeSessions(
  current: ChatSessionMeta[],
  incoming: ChatSessionMeta[],
): ChatSessionMeta[] {
  const byId = new Map<string, ChatSessionMeta>();
  for (const s of current) byId.set(s._id, s);
  for (const s of incoming) byId.set(s._id, s);
  return Array.from(byId.values()).sort(compareSessions);
}

/** Map a wire entry explicitly — `usage` is what the menu prices with. */
function toSessionMeta(raw: {
  _id: string;
  title?: string;
  createdAt?: string;
  updatedAt?: string;
  activeStreamId?: string | null;
  usage?: { totalTokens?: number; costUsd?: number };
}): ChatSessionMeta {
  const usage = raw.usage;
  return {
    _id: raw._id,
    title: raw.title ?? "",
    createdAt: raw.createdAt,
    updatedAt: raw.updatedAt,
    activeStreamId: raw.activeStreamId,
    usage:
      usage && typeof usage === "object"
        ? {
            totalTokens:
              typeof usage.totalTokens === "number"
                ? usage.totalTokens
                : undefined,
            costUsd:
              typeof usage.costUsd === "number" ? usage.costUsd : undefined,
          }
        : undefined,
  };
}

async function fetchPage(
  workspaceId: string,
  cursor: string | null,
): Promise<{ sessions: ChatSessionMeta[]; nextCursor: string | null } | null> {
  const { data, response } = await api.GET(
    "/api/workspaces/{workspaceId}/chats",
    {
      params: {
        path: { workspaceId },
        query: {
          limit: CHAT_HISTORY_PAGE_SIZE,
          ...(cursor ? { cursor } : {}),
        },
      },
    },
  );
  if (!response.ok || !data || !Array.isArray(data.chats)) return null;
  return {
    sessions: data.chats.map(toSessionMeta),
    nextCursor: typeof data.nextCursor === "string" ? data.nextCursor : null,
  };
}

const EMPTY = {
  workspaceId: null,
  sessions: [],
  nextCursor: null,
  loaded: false,
  loadingFirst: false,
  loadingMore: false,
} satisfies Partial<ChatHistoryState>;

export const useChatHistoryStore = create<ChatHistoryState>()(
  immer((set, get) => ({
    ...EMPTY,

    refresh: async workspaceId => {
      if (get().workspaceId !== workspaceId) {
        epoch++;
        set(s => {
          Object.assign(s, EMPTY);
          s.workspaceId = workspaceId;
        });
      }
      const myEpoch = epoch;
      const mySeq = ++refreshSeq;
      set(s => {
        s.loadingFirst = true;
      });
      let page: Awaited<ReturnType<typeof fetchPage>> = null;
      try {
        page = await fetchPage(workspaceId, null);
      } catch {
        page = null;
      }
      if (myEpoch !== epoch || mySeq !== refreshSeq) return;
      set(s => {
        s.loadingFirst = false;
        if (!page) return;
        // The first load takes the page's cursor; later refreshes keep the
        // deeper cursor already reached and only fold the top page in.
        if (!s.loaded) s.nextCursor = page.nextCursor;
        s.sessions = mergeSessions(s.sessions, page.sessions);
        s.loaded = true;
      });
    },

    loadMore: async () => {
      const { workspaceId, nextCursor, loadingMore, loaded } = get();
      if (!workspaceId || !nextCursor || loadingMore || !loaded) return;
      const myEpoch = epoch;
      set(s => {
        s.loadingMore = true;
      });
      let page: Awaited<ReturnType<typeof fetchPage>> = null;
      try {
        page = await fetchPage(workspaceId, nextCursor);
      } catch {
        page = null;
      }
      if (myEpoch !== epoch) return;
      set(s => {
        s.loadingMore = false;
        // Only advance from the cursor this page was read at.
        if (!page || s.nextCursor !== nextCursor) return;
        s.sessions = mergeSessions(s.sessions, page.sessions);
        s.nextCursor = page.nextCursor;
      });
    },

    deleteSession: async (workspaceId, id) => {
      try {
        const { response } = await api.DELETE(
          "/api/workspaces/{workspaceId}/chats/{id}",
          { params: { path: { workspaceId, id } } },
        );
        if (!response.ok) return false;
        set(s => {
          if (s.workspaceId === workspaceId) {
            s.sessions = s.sessions.filter(session => session._id !== id);
          }
        });
        return true;
      } catch {
        return false;
      }
    },

    reset: () => {
      epoch++;
      set(s => {
        Object.assign(s, EMPTY);
      });
    },
  })),
);

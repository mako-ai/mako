import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import {
  useChatHistoryStore,
  type ChatSessionMeta,
} from "../../../store/chatHistoryStore";
import { useRealtimeStore } from "../../../store/realtimeStore";

export type {
  ChatSessionMeta,
  ChatSessionUsage,
} from "../../../store/chatHistoryStore";

export interface UseChatSessionsArgs {
  workspaceId: string | undefined;
}

const EMPTY: ChatSessionMeta[] = [];

/**
 * Chat session list for the history menu: fetch, live streaming indicator,
 * delete, and the menu anchor state. The list itself (pages, cursor, merge)
 * lives in chatHistoryStore, and the menu loads further pages from it on
 * scroll. Selecting/creating a session is cross-cutting orchestration
 * (queue, gate, messages) and stays in Chat.tsx.
 */
export function useChatSessions({ workspaceId }: UseChatSessionsArgs): {
  sessions: ChatSessionMeta[];
  /**
   * Re-reads the first page and merges it in (new/updated chats rise to the
   * top, deeper pages stay) — useChat's onFinish refreshes through this ref.
   */
  fetchSessionsRef: MutableRefObject<(() => Promise<void>) | undefined>;
  isSessionStreaming: (session: ChatSessionMeta) => boolean;
  /** Deletes the session server-side; resolves true on success. */
  deleteSession: (id: string) => Promise<boolean>;
  historyMenuAnchor: HTMLElement | null;
  historyMenuOpen: boolean;
  handleHistoryMenuOpen: (event: React.MouseEvent<HTMLElement>) => void;
  handleHistoryMenuClose: () => void;
} {
  const storeWorkspaceId = useChatHistoryStore(s => s.workspaceId);
  const storeSessions = useChatHistoryStore(s => s.sessions);
  // Never show another workspace's list while the new one loads.
  const sessions =
    workspaceId && storeWorkspaceId === workspaceId ? storeSessions : EMPTY;
  const [historyMenuAnchor, setHistoryMenuAnchor] =
    useState<null | HTMLElement>(null);
  const historyMenuOpen = Boolean(historyMenuAnchor);

  // Ref-based so useChat's onFinish (declared before this hook's consumers
  // re-render) always reaches the current workspace.
  const fetchSessionsRef = useRef<() => Promise<void>>(undefined);
  fetchSessionsRef.current = async () => {
    if (!workspaceId) return;
    await useChatHistoryStore.getState().refresh(workspaceId);
  };

  // Fetch the first page when the workspace resolves/changes.
  useEffect(() => {
    void fetchSessionsRef.current?.();
  }, [workspaceId]);

  // Live per-chat activity from the realtime channel. The server-fetched
  // activeStreamId is the initial value (correct on cold open); chat.activity
  // events keep it current while the menu is open — including turns started
  // by other windows or continuing server-side after a detach.
  const chatActivity = useRealtimeStore(s => s.chatActivity);
  const isSessionStreaming = useCallback(
    (session: ChatSessionMeta): boolean => {
      const live = chatActivity[session._id];
      if (live === "streaming") return true;
      if (live === "idle") return false;
      return Boolean(session.activeStreamId);
    },
    [chatActivity],
  );

  const deleteSession = useCallback(
    async (id: string): Promise<boolean> => {
      if (!workspaceId) return false;
      return useChatHistoryStore.getState().deleteSession(workspaceId, id);
    },
    [workspaceId],
  );

  const handleHistoryMenuOpen = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      setHistoryMenuAnchor(event.currentTarget);
      // The list goes stale the moment a new chat starts a turn (the doc is
      // created server-side at turn start) — refresh the first page on every
      // open so in-flight chats appear immediately with their streaming
      // indicator. Deeper pages already loaded are kept.
      void fetchSessionsRef.current?.();
    },
    [],
  );

  const handleHistoryMenuClose = useCallback(() => {
    setHistoryMenuAnchor(null);
  }, []);

  return {
    sessions,
    fetchSessionsRef,
    isSessionStreaming,
    deleteSession,
    historyMenuAnchor,
    historyMenuOpen,
    handleHistoryMenuOpen,
    handleHistoryMenuClose,
  };
}

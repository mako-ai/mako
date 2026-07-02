import {
  useCallback,
  useEffect,
  useRef,
  useState,
  type MutableRefObject,
} from "react";
import { api } from "../../../api/client";
import { useRealtimeStore } from "../../../store/realtimeStore";

export interface ChatSessionMeta {
  _id: string;
  title: string;
  createdAt?: string;
  updatedAt?: string;
  /** Resume pointer set while a turn is generating server-side. */
  activeStreamId?: string | null;
}

export interface UseChatSessionsArgs {
  workspaceId: string | undefined;
}

/**
 * Chat session list for the history menu: fetch, live streaming indicator,
 * delete, and the menu anchor state. Selecting/creating a session is
 * cross-cutting orchestration (queue, gate, messages) and stays in Chat.tsx.
 */
export function useChatSessions({ workspaceId }: UseChatSessionsArgs): {
  sessions: ChatSessionMeta[];
  /** Latest fetch — useChat's onFinish refreshes the list through this ref. */
  fetchSessionsRef: MutableRefObject<(() => Promise<void>) | undefined>;
  isSessionStreaming: (session: ChatSessionMeta) => boolean;
  /** Deletes the session server-side; resolves true on success. */
  deleteSession: (id: string) => Promise<boolean>;
  historyMenuAnchor: HTMLElement | null;
  historyMenuOpen: boolean;
  handleHistoryMenuOpen: (event: React.MouseEvent<HTMLElement>) => void;
  handleHistoryMenuClose: () => void;
} {
  const [sessions, setSessions] = useState<ChatSessionMeta[]>([]);
  const [historyMenuAnchor, setHistoryMenuAnchor] =
    useState<null | HTMLElement>(null);
  const historyMenuOpen = Boolean(historyMenuAnchor);

  // Ref-based so useChat's onFinish (declared before this hook's consumers
  // re-render) always reaches the current workspace.
  const fetchSessionsRef = useRef<() => Promise<void>>();
  fetchSessionsRef.current = async () => {
    if (!workspaceId) return;
    try {
      const { data, response } = await api.GET(
        "/api/workspaces/{workspaceId}/chats",
        { params: { path: { workspaceId } } },
      );
      if (response.ok && Array.isArray(data)) {
        setSessions(data as ChatSessionMeta[]);
      }
    } catch {
      /* ignore */
    }
  };

  // Fetch available chat sessions when the workspace resolves/changes.
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
      try {
        const { response } = await api.DELETE(
          "/api/workspaces/{workspaceId}/chats/{id}",
          { params: { path: { workspaceId, id } } },
        );
        if (response.ok) {
          setSessions(prev => prev.filter(s => s._id !== id));
          return true;
        }
      } catch {
        /* ignore */
      }
      return false;
    },
    [workspaceId],
  );

  const handleHistoryMenuOpen = useCallback(
    (event: React.MouseEvent<HTMLElement>) => {
      setHistoryMenuAnchor(event.currentTarget);
      // The list goes stale the moment a new chat starts a turn (the doc is
      // created server-side at turn start) — refresh it on every open so
      // in-flight chats appear immediately with their streaming indicator.
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

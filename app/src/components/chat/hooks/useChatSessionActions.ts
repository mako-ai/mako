import { useEffect, useRef, useState } from "react";
import { useUIStore } from "../../../store/uiStore";
import { useConfirm } from "../../ConfirmDialog";
import { generateObjectId } from "../../../utils/objectId";
import {
  readStoredChatSession,
  writeStoredChatSession,
} from "../session-storage";
import { useRealtimeStore } from "../../../store/realtimeStore";

/**
 * Which chat this panel shows: restored from the per-tab session pointer on
 * mount, kept in that pointer (and registered with the realtime store) as it
 * changes. `isExistingChat` marks a chat from history (its persisted messages
 * load before reattaching to a live stream).
 */
export function useChatIdentity() {
  // The chat persisted for this tab (if any), read once per mount. Restoring
  // it means a page refresh reopens — and reattaches to — the same chat.
  const [initialStoredSession] = useState(readStoredChatSession);
  // chatId is a MongoDB ObjectId generated locally - frontend owns the ID (AI SDK best practice)
  const [chatId, setChatId] = useState<string>(
    () => initialStoredSession?.chatId ?? generateObjectId(),
  );
  // A chat restored from sessionStorage is treated as existing so its
  // persisted messages are loaded before reattaching to the live stream.
  const [isExistingChat, setIsExistingChat] = useState(() =>
    Boolean(initialStoredSession),
  );
  return {
    initialStoredSession,
    chatId,
    setChatId,
    isExistingChat,
    setIsExistingChat,
  };
}

interface UseChatSessionActionsArgs {
  workspaceId: string | undefined;
  chatId: string;
  initialStoredSession: ReturnType<typeof readStoredChatSession>;
  setChatId: (id: string) => void;
  setIsExistingChat: (value: boolean) => void;
  /** Tear down the current chat's in-flight state (tools, queue, binding). */
  resetTurnState: () => void;
  setMessages: (messages: never[]) => void;
  deleteSession: (id: string) => Promise<boolean>;
  onHistoryMenuClose: () => void;
  onError: (message: string) => void;
}

/** New chat / open from history / delete, and the "Ask Mako" draft hand-off. */
export function useChatSessionActions({
  workspaceId,
  chatId,
  initialStoredSession,
  setChatId,
  setIsExistingChat,
  resetTurnState,
  setMessages,
  deleteSession,
  onHistoryMenuClose,
  onError,
}: UseChatSessionActionsArgs) {
  const confirm = useConfirm();

  // Validate the restored per-tab chat once the workspace resolves: a chat
  // persisted for a different workspace must not leak into this one.
  const sessionRestoreCheckedRef = useRef(false);
  useEffect(() => {
    if (!workspaceId || sessionRestoreCheckedRef.current) return;
    sessionRestoreCheckedRef.current = true;
    if (
      initialStoredSession &&
      initialStoredSession.workspaceId !== workspaceId
    ) {
      setChatId(generateObjectId());
      setMessages([]);
      setIsExistingChat(false);
    }
  }, [
    workspaceId,
    setMessages,
    initialStoredSession,
    setChatId,
    setIsExistingChat,
  ]);

  // Keep the per-tab session pointer current so a refresh restores this chat.
  useEffect(() => {
    if (!workspaceId) return;
    writeStoredChatSession({ chatId, workspaceId });
    // Register the active chat with the realtime store so chat.ui-intent
    // events (e.g. the agent opening a console) only act on the chat this
    // window is actually viewing.
    useRealtimeStore.getState().setActiveChatId(chatId);
    return () => {
      useRealtimeStore.getState().setActiveChatId(null);
    };
  }, [chatId, workspaceId]);

  // Create new chat session - just generate a new ID locally (no API call needed)
  const createNewSession = () => {
    resetTurnState();
    setChatId(generateObjectId());
    setMessages([]);
    setIsExistingChat(false);
  };

  // A screen asked for a new chat with a first message written
  // ("Ask Mako to fix"): start one and put the message in the composer.
  const chatDraft = useUIStore(s => s.chatDraft);
  const [composerDraft, setComposerDraft] = useState<typeof chatDraft>(null);
  const createNewSessionRef = useRef(createNewSession);
  createNewSessionRef.current = createNewSession;
  useEffect(() => {
    if (!chatDraft) return;
    createNewSessionRef.current();
    setComposerDraft(chatDraft);
    useUIStore.getState().clearChatDraft();
  }, [chatDraft]);

  const handleSelectSession = (id: string) => {
    resetTurnState();
    setChatId(id);
    setMessages([]);
    setIsExistingChat(true);
    onHistoryMenuClose();
  };

  const handleDeleteSession = async (id: string, e: React.MouseEvent) => {
    e.stopPropagation();
    // Deleting a chat is irreversible and the control sits one row away from
    // "open this chat", so it must be confirmed.
    const ok = await confirm({
      title: "Delete this chat?",
      body: "The conversation and its history are removed for good.",
      confirmLabel: "Delete",
      destructive: true,
    });
    if (!ok) return;
    const deleted = await deleteSession(id);
    if (!deleted) {
      onError("Could not delete that chat. Please try again.");
      return;
    }
    // If we deleted the current chat, start a new one.
    if (chatId === id) {
      createNewSession();
    }
  };

  return {
    composerDraft,
    createNewSession,
    handleSelectSession,
    handleDeleteSession,
  };
}

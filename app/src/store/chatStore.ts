import { useAppStore, ChatSession } from "./appStore";
import { Message } from "../types/chat";
import { useMemo } from "react";

export const useChatStore = () => {
  const dispatch = useAppStore(s => s.dispatch);
  const sessions = useAppStore(s => s.chat.sessions);
  const currentChatId = useAppStore(s => s.chat.currentChatId);
  const selectedModelGlobal = useAppStore(s => s.settings.modelId);

  const value = useMemo(() => {
    const chatSessions: ChatSession[] = Object.values(sessions);

    const getCurrentChat = () =>
      currentChatId ? sessions[currentChatId] || null : null;
    const getCurrentMessages = () => getCurrentChat()?.messages || [];

    const createNewChat = () => {
      // Check if current chat is empty and can be reused
      if (currentChatId) {
        const currentChat = sessions[currentChatId];
        if (currentChat && currentChat.messages.length === 0) {
          // Reuse existing empty chat
          return currentChatId;
        }
      }

      // Create new chat
      const id = Date.now().toString() + Math.random();
      dispatch({ type: "CREATE_CHAT", payload: { id } } as any);
      return id;
    };

    const setCurrentChat = (chatId: string) =>
      dispatch({ type: "FOCUS_CHAT", payload: { id: chatId } } as any);

    const deleteChat = (_chatId: string) => {};

    const addMessage = (message: Message) => {
      if (!currentChatId) return;
      dispatch({
        type: "ADD_MESSAGE",
        payload: { chatId: currentChatId, message },
      } as any);
    };

    const updateMessage = (id: string, content: string) => {
      if (!currentChatId) return;
      dispatch({
        type: "UPDATE_MESSAGE_PARTIAL",
        payload: { chatId: currentChatId, messageId: id, delta: content },
      } as any);
    };

    const setSelectedModel = (model: string) =>
      dispatch({ type: "SET_SELECTED_MODEL", payload: { model } } as any);

    const error = getCurrentChat()?.error || null;
    const setError = (_e: string | null) => {};

    return {
      chatSessions,
      currentChatId,
      createNewChat,
      setCurrentChat,
      deleteChat,
      getCurrentChat,
      getCurrentMessages,
      addMessage,
      updateMessage,
      clearCurrentMessages: () => {},
      selectedModel: selectedModelGlobal,
      setSelectedModel,
      error,
      setError,
    };
  }, [sessions, currentChatId, dispatch, selectedModelGlobal]);

  return value;
};

// Provide getState for legacy direct access
// eslint-disable-next-line @typescript-eslint/ban-ts-comment
// @ts-ignore – attach property dynamically
useChatStore.getState = () => {
  const global = useAppStore.getState();
  const dispatch = global.dispatch;
  const currentChatId = global.chat.currentChatId;
  const currentChat = currentChatId
    ? global.chat.sessions[currentChatId]
    : null;

  const buildFacade = (): any => {
    const chatSessions: ChatSession[] = Object.values(global.chat.sessions);

    const addMessage = (message: Message) => {
      if (!currentChatId) return;
      dispatch({
        type: "ADD_MESSAGE",
        payload: { chatId: currentChatId, message },
      });
    };

    const updateMessage = (id: string, content: string) => {
      if (!currentChatId) return;
      dispatch({
        type: "UPDATE_MESSAGE_PARTIAL",
        payload: { chatId: currentChatId, messageId: id, delta: content },
      });
    };

    const setSelectedModel = (model: string) =>
      dispatch({ type: "SET_SELECTED_MODEL", payload: { model } });

    return {
      chatSessions,
      currentChatId,
      getCurrentChat: () => currentChat,
      getCurrentMessages: () => currentChat?.messages || [],
      createNewChat: () => {
        // Check if current chat is empty and can be reused
        if (currentChatId) {
          const currentChat = global.chat.sessions[currentChatId];
          if (currentChat && currentChat.messages.length === 0) {
            // Reuse existing empty chat
            return currentChatId;
          }
        }

        // Create new chat
        const id = Date.now().toString() + Math.random();
        dispatch({ type: "CREATE_CHAT", payload: { id } });
        return id;
      },
      setCurrentChat: (chatId: string) =>
        dispatch({ type: "FOCUS_CHAT", payload: { id: chatId } }),
      deleteChat: (_chatId: string) => {},
      addMessage,
      updateMessage,
      clearCurrentMessages: () => {},
      selectedModel: global.settings.modelId,
      setSelectedModel,
      error: currentChat?.error || null,
      setError: (_e: string | null) => {},
    };
  };

  return buildFacade();
};

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { immer } from "zustand/middleware/immer";
import type { ChatSession, Message } from "./lib/types";

interface ChatState {
  sessions: Record<string, ChatSession>;
  currentChatId: string | null;
  error: Record<string, string | null>;
}

interface ChatActions {
  createChat: () => string;
  focusChat: (id: string) => void;
  deleteChat: (id: string) => void;
  addMessage: (chatId: string, message: Message) => void;
  updateMessage: (chatId: string, messageId: string, content: string) => void;
  clearMessages: (chatId: string) => void;
  setError: (chatId: string, error: string | null) => void;
  reset: () => void;
}

type ChatStore = ChatState & ChatActions;

const createDefaultChatId = () => `default-${Date.now()}`;

const createDefaultChat = (): ChatSession => {
  const id = createDefaultChatId();
  return {
    id,
    title: "New Chat",
    messages: [],
    createdAt: new Date(),
  };
};

const createInitialState = (): ChatState => {
  const defaultChat = createDefaultChat();
  return {
    sessions: {
      [defaultChat.id]: defaultChat,
    },
    currentChatId: defaultChat.id,
    error: {},
  };
};

export const useChatStore = create<ChatStore>()(
  persist(
    immer((set, get) => ({
      ...createInitialState(),

      createChat: () => {
        const currentChatId = get().currentChatId;
        if (currentChatId) {
          const currentChat = get().sessions[currentChatId];
          if (currentChat && currentChat.messages.length === 0) {
            set(state => {
              state.error[currentChatId] = null;
            });
            return currentChatId;
          }
        }

        const id = `chat-${Date.now()}-${Math.random().toString(36).slice(2)}`;
        const newChat: ChatSession = {
          id,
          title: "New Chat",
          messages: [],
          createdAt: new Date(),
        };

        set(state => {
          state.sessions[id] = newChat;
          state.currentChatId = id;
          state.error[id] = null;
        });

        return id;
      },

      focusChat: id =>
        set(state => {
          state.currentChatId = id;
        }),

      deleteChat: id =>
        set(state => {
          delete state.sessions[id];
          delete state.error[id];

          if (state.currentChatId === id) {
            const remainingIds = Object.keys(state.sessions);
            state.currentChatId = remainingIds[0] || null;
          }

          // Ensure at least one chat exists
          if (!state.currentChatId) {
            const defaultChat = createDefaultChat();
            state.sessions[defaultChat.id] = defaultChat;
            state.currentChatId = defaultChat.id;
          }
        }),

      addMessage: (chatId, message) =>
        set(state => {
          const chat = state.sessions[chatId];
          if (!chat) return;

          chat.messages.push(message);
          chat.lastMessageAt = new Date();
          if (chat.messages[0]?.content) {
            chat.title =
              chat.messages[0].content.substring(0, 50) || chat.title;
          }
        }),

      updateMessage: (chatId, messageId, content) =>
        set(state => {
          const chat = state.sessions[chatId];
          if (!chat) return;

          const msg = chat.messages.find(m => m.id === messageId);
          if (msg) {
            msg.content = content;
          }
        }),

      clearMessages: chatId =>
        set(state => {
          const chat = state.sessions[chatId];
          if (chat) {
            chat.messages = [];
            chat.lastMessageAt = undefined;
          }
        }),

      setError: (chatId, error) =>
        set(state => {
          state.error[chatId] = error;
        }),

      reset: () => set(createInitialState()),
    })),
    {
      name: "chat-store",
      partialize: state => ({
        sessions: Object.fromEntries(
          Object.entries(state.sessions).filter(
            ([, session]) => session.messages.length > 0,
          ),
        ),
        currentChatId: state.currentChatId,
      }),
      storage: {
        getItem: name => {
          const str = localStorage.getItem(name);
          if (str) {
            const data = JSON.parse(str);
            if (data.state?.sessions) {
              Object.values(data.state.sessions).forEach((session: any) => {
                session.createdAt = new Date(session.createdAt);
                if (session.lastMessageAt) {
                  session.lastMessageAt = new Date(session.lastMessageAt);
                }
                session.messages?.forEach((msg: any) => {
                  msg.timestamp = new Date(msg.timestamp);
                });
              });
            }

            // Ensure we have at least one chat session
            if (
              !data.state?.sessions ||
              Object.keys(data.state.sessions).length === 0
            ) {
              const fallback = createDefaultChat();
              data.state = {
                ...data.state,
                sessions: { [fallback.id]: fallback },
                currentChatId: fallback.id,
              };
            } else {
              const sessions = data.state.sessions;
              const currentId = data.state.currentChatId;
              if (!currentId || !sessions[currentId]) {
                data.state.currentChatId = Object.keys(sessions)[0];
              }
            }

            return data;
          }

          // Migration: fallback to app-store data if present
          const legacy = localStorage.getItem("app-store");
          if (legacy) {
            try {
              const parsed = JSON.parse(legacy);
              const sessions = parsed.state?.chat?.sessions || {};
              const currentChatId = parsed.state?.chat?.currentChatId || null;

              Object.values(sessions).forEach((session: any) => {
                session.createdAt = new Date(session.createdAt);
                if (session.lastMessageAt) {
                  session.lastMessageAt = new Date(session.lastMessageAt);
                }
                session.messages?.forEach((msg: any) => {
                  msg.timestamp = new Date(msg.timestamp);
                });
              });

              const fallbackId =
                currentChatId && sessions[currentChatId]
                  ? currentChatId
                  : Object.keys(sessions)[0];

              return {
                state: {
                  sessions,
                  currentChatId: fallbackId || null,
                  error: {},
                },
                version: 0,
              };
            } catch (error) {
              console.error("Failed to parse legacy chat store:", error);
            }
          }

          return null;
        },
        setItem: (name, value) => {
          localStorage.setItem(name, JSON.stringify(value));
        },
        removeItem: name => {
          localStorage.removeItem(name);
        },
      },
    },
  ),
);

// Selectors
export const selectChatSessions = (state: ChatStore): ChatSession[] =>
  Object.values(state.sessions);
export const selectCurrentChatId = (state: ChatStore) => state.currentChatId;
export const selectCurrentChat = (state: ChatStore): ChatSession | null => {
  const id = state.currentChatId;
  return id ? state.sessions[id] || null : null;
};
export const selectCurrentMessages = (state: ChatStore): Message[] => {
  const chat = selectCurrentChat(state);
  return chat?.messages || [];
};

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { persist } from "zustand/middleware";
import { Message, AttachedContext } from "../types/chat";

/*********************
 * State definitions *
 *********************/
export interface ChatSession {
  id: string;
  title: string;
  messages: Message[];
  attachedContext: AttachedContext[];
  createdAt: Date;
  lastMessageAt?: Date;
  error?: string | null;
}

export interface ConsoleTab {
  id: string;
  title: string;
  content: string;
  initialContent: string;
  dbContentHash?: string; // Hash of the content last saved to database
  connectionId?: string; // DatabaseConnection ID (MongoDB ObjectId)
  databaseId?: string; // Specific database ID (e.g., D1 UUID for cluster mode)
  databaseName?: string; // Human-readable database name (e.g., D1 database name)
  filePath?: string;
  kind?: "console" | "settings" | "connectors" | "members" | "sync-job-editor";
  isDirty?: boolean; // false/undefined = pristine (replaceable), true = dirty (persistent)
  icon?: string; // URL or path to icon, e.g., "/api/connectors/stripe/icon.svg"
  metadata?: Record<string, any>; // Additional data for special tab types
}

export interface GlobalState {
  // Backward-compatibility top-level view props
  activeView?: "databases" | "consoles" | "connectors" | "sync-jobs";
  activeEditorContent?: {
    content: string;
    fileName?: string;
    language?: string;
  };
  currentWorkspaceId?: string | null;
  ui: {
    leftPane: "databases" | "consoles" | "connectors" | "sync-jobs";
    loading: Record<string, boolean>; // keyed by request name
  };
  explorers: {
    database: {
      expandedServers: string[];
      expandedDatabases: string[];
      expandedCollectionGroups: string[];
      expandedViewGroups: string[];
      expandedNodes: string[];
    };
    console: {
      expandedFolders: string[];
    };
    view: {
      expandedCollections: string[];
    };
  };
  settings: {
    modelId: string;
    apiKey?: string;
  };
  consoles: {
    tabs: Record<string, ConsoleTab>;
    activeTabId: string | null;
  };
  chat: {
    sessions: Record<string, ChatSession>;
    currentChatId: string | null;
  };
}

export type AppView = "databases" | "consoles" | "connectors" | "sync-jobs";

/*********************
 * Initial state     *
 *********************/
const createDefaultChatId = () => "default-" + Date.now();

// Initial state factory to ensure fresh dates/IDs
const getInitialState = (): GlobalState => {
  const defaultChatId = createDefaultChatId();
  return {
    activeView: "consoles",
    activeEditorContent: undefined,
    currentWorkspaceId: null,
    ui: {
      leftPane: "databases",
      loading: {},
    },
    explorers: {
      database: {
        expandedServers: [],
        expandedDatabases: [],
        expandedCollectionGroups: [],
        expandedViewGroups: [],
        expandedNodes: [],
      },
      console: {
        expandedFolders: [],
      },
      view: {
        expandedCollections: [],
      },
    },
    settings: {
      modelId: "gpt-3.5-turbo",
    },
    consoles: {
      tabs: {},
      activeTabId: null,
    },
    chat: {
      sessions: {
        [defaultChatId]: {
          id: defaultChatId,
          title: "New Chat",
          messages: [],
          attachedContext: [],
          createdAt: new Date(),
        },
      },
      currentChatId: defaultChatId,
    },
  };
};

export const initialState: GlobalState = getInitialState();

/*********************
 * Action definition *
 *********************/
export type Action =
  | {
      type: "OPEN_CONSOLE_TAB";
      payload: Omit<ConsoleTab, "initialContent"> & { initialContent: string };
    }
  | { type: "CLOSE_CONSOLE_TAB"; payload: { id: string } }
  | { type: "FOCUS_CONSOLE_TAB"; payload: { id: string | null } }
  | { type: "UPDATE_CONSOLE_CONTENT"; payload: { id: string; content: string } }
  | { type: "UPDATE_CONSOLE_TITLE"; payload: { id: string; title: string } }
  | { type: "UPDATE_CONSOLE_DIRTY"; payload: { id: string; isDirty: boolean } }
  | { type: "UPDATE_CONSOLE_ICON"; payload: { id: string; icon: string } }
  | {
      type: "UPDATE_CONSOLE_CONNECTION";
      payload: { id: string; connectionId?: string };
    }
  | {
      type: "UPDATE_CONSOLE_DATABASE";
      payload: {
        id: string;
        databaseId?: string;
        databaseName?: string;
      };
    }
  | {
      type: "UPDATE_CONSOLE_DB_HASH";
      payload: { id: string; dbContentHash: string };
    }
  | {
      type: "UPDATE_CONSOLE_FILE_PATH";
      payload: { id: string; filePath: string };
    }
  | {
      type: "SET_ATTACHED_CONTEXT";
      payload: { chatId: string; items: AttachedContext[] };
    }
  | { type: "ADD_MESSAGE"; payload: { chatId: string; message: Message } }
  | {
      type: "UPDATE_MESSAGE_PARTIAL";
      payload: { chatId: string; messageId: string; delta: string };
    }
  | { type: "CREATE_CHAT"; payload: { id: string } }
  | { type: "FOCUS_CHAT"; payload: { id: string } }
  | { type: "SET_LOADING"; payload: { key: string; value: boolean } }
  | {
      type: "NAVIGATE_LEFT_PANE";
      payload: { pane: "databases" | "consoles" | "connectors" | "sync-jobs" };
    }
  | {
      type: "SET_ACTIVE_EDITOR_CONTENT";
      payload: {
        content?: { content: string; fileName?: string; language?: string };
      };
    }
  | { type: "TOGGLE_DATABASE_SERVER"; payload: { serverId: string } }
  | { type: "TOGGLE_DATABASE_DATABASE"; payload: { databaseId: string } }
  | {
      type: "TOGGLE_DATABASE_COLLECTION_GROUP";
      payload: { databaseId: string };
    }
  | { type: "TOGGLE_DATABASE_VIEW_GROUP"; payload: { databaseId: string } }
  | { type: "TOGGLE_DATABASE_NODE"; payload: { nodeId: string } }
  | { type: "EXPAND_DATABASE_SERVER"; payload: { serverId: string } }
  | { type: "EXPAND_DATABASE_DATABASE"; payload: { databaseId: string } }
  | { type: "TOGGLE_CONSOLE_FOLDER"; payload: { folderPath: string } }
  | { type: "TOGGLE_VIEW_COLLECTION"; payload: { collectionName: string } }
  | { type: "EXPAND_VIEW_COLLECTION"; payload: { collectionName: string } }
  | { type: "SET_SELECTED_MODEL"; payload: { model: string } };

/*********************
 * Reducer           *
 *********************/
export const reducer = (state: GlobalState, action: Action): void => {
  switch (action.type) {
    case "OPEN_CONSOLE_TAB": {
      const {
        id,
        title,
        content,
        initialContent,
        dbContentHash,
        connectionId,
        databaseId,
        databaseName,
        filePath,
        kind,
        icon,
        metadata,
      } = action.payload;

      // Check if there's an existing pristine tab to replace
      const pristineTabId = Object.keys(state.consoles.tabs).find(
        tabId => !state.consoles.tabs[tabId].isDirty,
      );

      // If there's a pristine tab, remove it first
      if (pristineTabId) {
        delete state.consoles.tabs[pristineTabId];
      }

      // Create new tab with the new ID
      state.consoles.tabs[id] = {
        id,
        title,
        content,
        initialContent,
        dbContentHash,
        connectionId,
        databaseId,
        databaseName,
        filePath,
        kind: kind || "console",
        isDirty: false, // New tabs start as pristine
        icon,
        metadata,
      };
      state.consoles.activeTabId = id;

      // auto-attach console context for virgin chat
      if (state.chat.currentChatId) {
        const chat = state.chat.sessions[state.chat.currentChatId];
        if (chat && chat.messages.length === 0) {
          chat.attachedContext = [
            {
              id,
              type: "console",
              title,
              content,
              metadata: { consoleId: id },
            },
          ];
        }
      }
      break;
    }
    case "CLOSE_CONSOLE_TAB": {
      delete state.consoles.tabs[action.payload.id];
      if (state.consoles.activeTabId === action.payload.id) {
        state.consoles.activeTabId =
          Object.keys(state.consoles.tabs)[0] || null;
      }

      // Handle chat context for virgin chats
      if (state.chat.currentChatId) {
        const chat = state.chat.sessions[state.chat.currentChatId];
        if (chat && chat.messages.length === 0) {
          if (state.consoles.activeTabId) {
            // Another console became active - attach it to virgin chat
            const newActiveTab =
              state.consoles.tabs[state.consoles.activeTabId];
            if (newActiveTab) {
              chat.attachedContext = [
                {
                  id: newActiveTab.id,
                  type: "console",
                  title: newActiveTab.title,
                  content: newActiveTab.content,
                  metadata: { consoleId: newActiveTab.id },
                },
              ];
            }
          } else {
            // No tabs remain - clear context in virgin chat
            chat.attachedContext = [];
          }
        }
      }
      break;
    }
    case "FOCUS_CONSOLE_TAB": {
      state.consoles.activeTabId = action.payload.id;

      // Handle chat context attachment for virgin chats
      if (state.chat.currentChatId) {
        const chat = state.chat.sessions[state.chat.currentChatId];
        if (chat && chat.messages.length === 0) {
          if (action.payload.id) {
            // Console focused - attach it to virgin chat
            const tab = state.consoles.tabs[action.payload.id];
            if (tab) {
              chat.attachedContext = [
                {
                  id: tab.id,
                  type: "console",
                  title: tab.title,
                  content: tab.content,
                  metadata: { consoleId: tab.id },
                },
              ];
            }
          } else {
            // No console focused - clear virgin chat context
            chat.attachedContext = [];
          }
        }
      }
      break;
    }
    case "UPDATE_CONSOLE_CONTENT": {
      const tab = state.consoles.tabs[action.payload.id];
      if (tab) tab.content = action.payload.content;

      // Update any attached console context in current chat
      if (state.chat.currentChatId) {
        const chat = state.chat.sessions[state.chat.currentChatId];
        if (chat && tab) {
          const contextIndex = chat.attachedContext.findIndex(
            ctx =>
              ctx.type === "console" &&
              ctx.metadata?.consoleId === action.payload.id,
          );
          if (contextIndex !== -1) {
            chat.attachedContext[contextIndex] = {
              ...chat.attachedContext[contextIndex],
              content: `Console: ${tab.title}\n\nCurrent Content:\n${tab.content}`,
            };
          }
        }
      }
      break;
    }
    case "UPDATE_CONSOLE_TITLE": {
      const tab = state.consoles.tabs[action.payload.id];
      if (tab) tab.title = action.payload.title;
      break;
    }
    case "UPDATE_CONSOLE_DIRTY": {
      const tab = state.consoles.tabs[action.payload.id];
      if (tab) tab.isDirty = action.payload.isDirty;
      break;
    }
    case "UPDATE_CONSOLE_ICON": {
      const tab = state.consoles.tabs[action.payload.id];
      if (tab) tab.icon = action.payload.icon;
      break;
    }
    case "UPDATE_CONSOLE_CONNECTION": {
      const tab = state.consoles.tabs[action.payload.id];
      if (tab) tab.connectionId = action.payload.connectionId;
      break;
    }
    case "UPDATE_CONSOLE_DATABASE": {
      const tab = state.consoles.tabs[action.payload.id];
      if (tab) {
        tab.databaseId = action.payload.databaseId;
        tab.databaseName = action.payload.databaseName;
      }
      break;
    }
    case "UPDATE_CONSOLE_DB_HASH": {
      const tab = state.consoles.tabs[action.payload.id];
      if (tab) tab.dbContentHash = action.payload.dbContentHash;
      break;
    }
    case "UPDATE_CONSOLE_FILE_PATH": {
      const tab = state.consoles.tabs[action.payload.id];
      if (tab) tab.filePath = action.payload.filePath;
      break;
    }
    case "CREATE_CHAT": {
      const { id } = action.payload;
      // If current chat is empty with no context, reuse it
      if (state.chat.currentChatId) {
        const currentChat = state.chat.sessions[state.chat.currentChatId];
        if (
          currentChat &&
          currentChat.messages.length === 0 &&
          currentChat.attachedContext.length === 0
        ) {
          // Just clear any error and return existing id
          currentChat.error = null;
          return;
        }
      }

      // Create new chat
      state.chat.sessions[id] = {
        id,
        title: "New Chat",
        messages: [],
        attachedContext: [],
        createdAt: new Date(),
      };
      state.chat.currentChatId = id;
      break;
    }
    case "FOCUS_CHAT": {
      state.chat.currentChatId = action.payload.id;
      break;
    }
    case "ADD_MESSAGE": {
      const { chatId, message } = action.payload;
      const chat = state.chat.sessions[chatId];
      if (chat) {
        chat.messages.push(message);
        chat.lastMessageAt = new Date();
        chat.title = chat.messages[0]?.content.substring(0, 50) || chat.title;
      }
      break;
    }
    case "UPDATE_MESSAGE_PARTIAL": {
      const { chatId, messageId, delta } = action.payload;
      const chat = state.chat.sessions[chatId];
      if (chat) {
        const msg = chat.messages.find(m => m.id === messageId);
        if (msg) msg.content += delta;
      }
      break;
    }
    case "SET_ATTACHED_CONTEXT": {
      const { chatId, items } = action.payload;
      const chat = state.chat.sessions[chatId];
      if (chat) chat.attachedContext = items;
      break;
    }
    case "SET_LOADING": {
      state.ui.loading[action.payload.key] = action.payload.value;
      break;
    }
    case "SET_SELECTED_MODEL": {
      state.settings.modelId = action.payload.model;
      break;
    }
    case "NAVIGATE_LEFT_PANE": {
      state.ui.leftPane = action.payload.pane;
      state.activeView = action.payload.pane; // sync legacy field
      break;
    }
    case "SET_ACTIVE_EDITOR_CONTENT": {
      state.activeEditorContent = action.payload.content;
      break;
    }
    case "TOGGLE_DATABASE_SERVER": {
      const { serverId } = action.payload;
      const expandedServers = state.explorers.database.expandedServers;
      if (expandedServers.includes(serverId)) {
        state.explorers.database.expandedServers = expandedServers.filter(
          id => id !== serverId,
        );
      } else {
        state.explorers.database.expandedServers.push(serverId);
      }
      break;
    }
    case "TOGGLE_DATABASE_DATABASE": {
      const { databaseId } = action.payload;
      const expandedDatabases = state.explorers.database.expandedDatabases;
      if (expandedDatabases.includes(databaseId)) {
        state.explorers.database.expandedDatabases = expandedDatabases.filter(
          id => id !== databaseId,
        );
      } else {
        state.explorers.database.expandedDatabases.push(databaseId);
      }
      break;
    }
    case "TOGGLE_DATABASE_COLLECTION_GROUP": {
      const { databaseId } = action.payload;
      const expandedCollectionGroups =
        state.explorers.database.expandedCollectionGroups;
      if (expandedCollectionGroups.includes(databaseId)) {
        state.explorers.database.expandedCollectionGroups =
          expandedCollectionGroups.filter(id => id !== databaseId);
      } else {
        state.explorers.database.expandedCollectionGroups.push(databaseId);
      }
      break;
    }
    case "TOGGLE_DATABASE_VIEW_GROUP": {
      const { databaseId } = action.payload;
      const expandedViewGroups = state.explorers.database.expandedViewGroups;
      if (expandedViewGroups.includes(databaseId)) {
        state.explorers.database.expandedViewGroups = expandedViewGroups.filter(
          id => id !== databaseId,
        );
      } else {
        state.explorers.database.expandedViewGroups.push(databaseId);
      }
      break;
    }
    case "TOGGLE_DATABASE_NODE": {
      const { nodeId } = action.payload;
      const expandedNodes = state.explorers.database.expandedNodes;
      if (expandedNodes.includes(nodeId)) {
        state.explorers.database.expandedNodes = expandedNodes.filter(
          id => id !== nodeId,
        );
      } else {
        state.explorers.database.expandedNodes.push(nodeId);
      }
      break;
    }
    case "EXPAND_DATABASE_SERVER": {
      const { serverId } = action.payload;
      const expandedServers = state.explorers.database.expandedServers;
      if (!expandedServers.includes(serverId)) {
        state.explorers.database.expandedServers.push(serverId);
      }
      break;
    }
    case "EXPAND_DATABASE_DATABASE": {
      const { databaseId } = action.payload;
      const expandedDatabases = state.explorers.database.expandedDatabases;
      if (!expandedDatabases.includes(databaseId)) {
        state.explorers.database.expandedDatabases.push(databaseId);
      }
      break;
    }
    case "TOGGLE_CONSOLE_FOLDER": {
      const { folderPath } = action.payload;
      const expandedFolders = state.explorers.console.expandedFolders;
      if (expandedFolders.includes(folderPath)) {
        state.explorers.console.expandedFolders = expandedFolders.filter(
          path => path !== folderPath,
        );
      } else {
        state.explorers.console.expandedFolders.push(folderPath);
      }
      break;
    }
    case "TOGGLE_VIEW_COLLECTION": {
      const { collectionName } = action.payload;
      const expandedCollections = state.explorers.view.expandedCollections;
      if (expandedCollections.includes(collectionName)) {
        state.explorers.view.expandedCollections = expandedCollections.filter(
          name => name !== collectionName,
        );
      } else {
        state.explorers.view.expandedCollections.push(collectionName);
      }
      break;
    }
    case "EXPAND_VIEW_COLLECTION": {
      const { collectionName } = action.payload;
      const expandedCollections = state.explorers.view.expandedCollections;
      if (!expandedCollections.includes(collectionName)) {
        state.explorers.view.expandedCollections.push(collectionName);
      }
      break;
    }
  }
};

/*********************
 * Store             *
 *********************/
export const useAppStore = create<
  GlobalState & {
    dispatch: (a: Action) => void;
    setActiveView: (
      view: "databases" | "consoles" | "connectors" | "sync-jobs",
    ) => void;
    setCurrentWorkspaceId: (workspaceId: string | null) => void;
    setActiveEditorContent: (
      content:
        | { content: string; fileName?: string; language?: string }
        | undefined,
    ) => void;
    reset: () => void;
  }
>()(
  persist(
    immer(set => ({
      ...initialState,
      dispatch: (action: Action) => set(state => reducer(state, action)),
      setActiveView: view =>
        set(state => {
          state.activeView = view;
          state.ui.leftPane = view;
        }),
      setCurrentWorkspaceId: workspaceId =>
        set(state => {
          state.currentWorkspaceId = workspaceId;
        }),
      setActiveEditorContent: content =>
        set(state => {
          state.activeEditorContent = content;
        }),
      reset: () => set(getInitialState()),
    })),
    {
      name: "app-store",
      partialize: state => ({
        // Persist chat sessions, console tabs, and settings
        activeView: state.activeView,
        currentWorkspaceId: state.currentWorkspaceId,
        chat: {
          sessions: Object.fromEntries(
            Object.entries(state.chat.sessions).filter(
              ([_, session]) => session.messages.length > 0,
            ),
          ),
          currentChatId: state.chat.currentChatId,
        },
        consoles: state.consoles,
        explorers: state.explorers,
        settings: state.settings,
        // Don't persist activeEditorContent (ephemeral)
      }),
      // Handle Date serialization/deserialization
      storage: {
        getItem: name => {
          const str = localStorage.getItem(name);
          if (!str) return null;

          const data = JSON.parse(str);
          // Convert timestamp strings back to Date objects
          if (data.state?.chat?.sessions) {
            Object.values(data.state.chat.sessions).forEach((session: any) => {
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
            !data.state?.chat?.sessions ||
            Object.keys(data.state.chat.sessions).length === 0
          ) {
            const newChatId = "restored-" + Date.now();
            const newChat = {
              id: newChatId,
              title: "New Chat",
              messages: [],
              attachedContext: [],
              createdAt: new Date(),
            };
            data.state = {
              ...data.state,
              chat: {
                sessions: { [newChatId]: newChat },
                currentChatId: newChatId,
              },
            };
          } else {
            // Ensure currentChatId points to an existing session
            const sessions = data.state.chat.sessions;
            const currentId = data.state.chat.currentChatId;
            if (!currentId || !sessions[currentId]) {
              const firstSessionId = Object.keys(sessions)[0];
              data.state.chat.currentChatId = firstSessionId;
            }
          }

          return data;
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

export const useAppDispatch = () => useAppStore(s => s.dispatch);

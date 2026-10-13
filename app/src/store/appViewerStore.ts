/**
 * The app viewer page (`/view/:workspaceId/:appId`) and its "chat with app"
 * panel: the published app's view URL, and the viewer's own chats with it.
 */
import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { api } from "../api/client";

export interface AppViewerState {
  status: "loading" | "ready" | "error";
  title?: string;
  /** Cookie-free view-token URL for the sandboxed iframe. */
  viewUrl?: string;
  /** Whether the app's owner allows chatting with it. */
  chatEnabled?: boolean;
  error?: string;
}

export interface AppChatSummary {
  id: string;
  title: string;
  updatedAt: string;
  streaming?: boolean;
}

export interface StoredAppChat {
  messages: unknown[];
  activeStreamId: string | null;
}

interface AppViewerStoreState {
  viewerByApp: Record<string, AppViewerState | undefined>;
  chatsByApp: Record<string, AppChatSummary[] | undefined>;
  /** Title and view URL of the published app. */
  openViewer: (workspaceId: string, appId: string) => Promise<void>;
  /** The caller's chats with this app, newest first. */
  fetchChats: (workspaceId: string, appId: string) => Promise<void>;
  /** One chat's persisted messages, or null when it cannot be read. */
  loadChat: (
    workspaceId: string,
    chatId: string,
  ) => Promise<StoredAppChat | null>;
  /** Abort the chat's in-flight generation server-side. */
  stopChat: (chatId: string) => Promise<void>;
  /** Delete one of the caller's chats with this app; true on success. */
  deleteChat: (
    workspaceId: string,
    appId: string,
    chatId: string,
  ) => Promise<boolean>;
}

export const appViewerKey = (workspaceId: string, appId: string) =>
  `${workspaceId}:${appId}`;

function openError(metaStatus: number, tokenStatus: number): string {
  if (metaStatus === 404 || metaStatus === 403) {
    return "This app doesn't exist or you don't have access to it.";
  }
  if (tokenStatus === 404) return "This app has not been published yet.";
  return "The app could not be opened.";
}

export const useAppViewerStore = create<AppViewerStoreState>()(
  immer(set => ({
    viewerByApp: {},
    chatsByApp: {},

    openViewer: async (workspaceId, appId) => {
      const key = appViewerKey(workspaceId, appId);
      set(s => {
        s.viewerByApp[key] = { status: "loading" };
      });
      const params = { params: { path: { workspaceId, id: appId } } };
      try {
        const [meta, token] = await Promise.all([
          api.GET("/api/workspaces/{workspaceId}/apps/{id}", params),
          api.POST(
            "/api/workspaces/{workspaceId}/apps/{id}/view-token",
            params,
          ),
        ]);
        const title =
          (meta.data as { app?: { title?: string } } | undefined)?.app?.title ||
          "App";
        const viewUrl = (token.data as { url?: string } | undefined)?.url;
        const chatEnabled =
          (meta.data as { app?: { chatEnabled?: boolean } } | undefined)?.app
            ?.chatEnabled === true;
        if (!meta.response.ok || !token.response.ok || !viewUrl) {
          const error = openError(meta.response.status, token.response.status);
          set(s => {
            s.viewerByApp[key] = { status: "error", error };
          });
          return;
        }
        set(s => {
          s.viewerByApp[key] = { status: "ready", title, viewUrl, chatEnabled };
        });
      } catch {
        set(s => {
          s.viewerByApp[key] = {
            status: "error",
            error: "The app could not be opened.",
          };
        });
      }
    },

    fetchChats: async (workspaceId, appId) => {
      try {
        const { data, response } = await api.GET(
          "/api/workspaces/{workspaceId}/apps/{id}/chats",
          { params: { path: { workspaceId, id: appId } } },
        );
        if (!response.ok || !data) return;
        const chats = (data as { chats?: AppChatSummary[] }).chats ?? [];
        set(s => {
          s.chatsByApp[appViewerKey(workspaceId, appId)] = chats;
        });
      } catch {
        // History is a convenience; the chat itself still works.
      }
    },

    loadChat: async (workspaceId, chatId) => {
      try {
        const { data, response } = await api.GET(
          "/api/workspaces/{workspaceId}/chats/{id}",
          { params: { path: { workspaceId, id: chatId } } },
        );
        if (!response.ok || !data) return null;
        const chat = data as {
          messages?: unknown[];
          activeStreamId?: string | null;
        };
        return {
          messages: chat.messages ?? [],
          activeStreamId: chat.activeStreamId ?? null,
        };
      } catch {
        return null;
      }
    },

    deleteChat: async (workspaceId, appId, chatId) => {
      try {
        const { response } = await api.DELETE(
          "/api/workspaces/{workspaceId}/chats/{id}",
          { params: { path: { workspaceId, id: chatId } } },
        );
        if (!response.ok) return false;
        set(s => {
          const key = appViewerKey(workspaceId, appId);
          s.chatsByApp[key] = (s.chatsByApp[key] ?? []).filter(
            chat => chat.id !== chatId,
          );
        });
        return true;
      } catch {
        return false;
      }
    },

    stopChat: async chatId => {
      await api
        .POST("/api/agent/chat/{chatId}/stop", {
          params: { path: { chatId } },
        })
        .catch(() => undefined);
    },
  })),
);

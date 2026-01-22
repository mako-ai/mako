import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";
import type {
  ApiKey,
  ApiKeyCreateResponse,
  ApiKeyDeleteResponse,
  ApiKeyListResponse,
} from "../lib/api-types";

interface ApiKeyState {
  keys: Record<string, ApiKey[]>;
  loading: Record<string, boolean>;
  error: Record<string, string | null>;
}

interface ApiKeyActions {
  fetchKeys: (workspaceId: string) => Promise<ApiKey[]>;
  createKey: (
    workspaceId: string,
    name: string,
  ) => Promise<ApiKeyCreateResponse>;
  deleteKey: (
    workspaceId: string,
    keyId: string,
  ) => Promise<ApiKeyDeleteResponse>;
  clearError: (workspaceId: string) => void;
}

type ApiKeyStore = ApiKeyState & ApiKeyActions;

const initialState: ApiKeyState = {
  keys: {},
  loading: {},
  error: {},
};

export const useApiKeyStore = create<ApiKeyStore>()(
  immer(set => ({
    ...initialState,

    fetchKeys: async workspaceId => {
      const key = `fetch:${workspaceId}`;
      set(state => {
        state.loading[key] = true;
        state.error[key] = null;
      });

      try {
        const response = await apiClient.get<ApiKeyListResponse>(
          `/workspaces/${workspaceId}/api-keys`,
        );
        const apiKeys = response.apiKeys || [];
        set(state => {
          state.keys[workspaceId] = apiKeys;
        });
        return apiKeys;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to fetch API keys";
        set(state => {
          state.error[key] = message;
        });
        return [];
      } finally {
        set(state => {
          delete state.loading[key];
        });
      }
    },

    createKey: async (workspaceId, name) => {
      const key = `create:${workspaceId}`;
      set(state => {
        state.loading[key] = true;
        state.error[key] = null;
      });

      try {
        const response = await apiClient.post<ApiKeyCreateResponse>(
          `/workspaces/${workspaceId}/api-keys`,
          { name },
        );

        if (response.success && response.apiKey) {
          const newKey = response.apiKey;
          set(state => {
            const existing = state.keys[workspaceId] || [];
            state.keys[workspaceId] = [newKey, ...existing];
          });
        }

        return response;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to create API key";
        set(state => {
          state.error[key] = message;
        });
        return { success: false, error: message };
      } finally {
        set(state => {
          delete state.loading[key];
        });
      }
    },

    deleteKey: async (workspaceId, keyId) => {
      const key = `delete:${workspaceId}`;
      set(state => {
        state.loading[key] = true;
        state.error[key] = null;
      });

      try {
        const response = await apiClient.delete<ApiKeyDeleteResponse>(
          `/workspaces/${workspaceId}/api-keys/${keyId}`,
        );

        if (response.success) {
          set(state => {
            state.keys[workspaceId] = (state.keys[workspaceId] || []).filter(
              apiKey => apiKey.id !== keyId,
            );
          });
        }

        return response;
      } catch (error) {
        const message =
          error instanceof Error ? error.message : "Failed to delete API key";
        set(state => {
          state.error[key] = message;
        });
        return { success: false, error: message };
      } finally {
        set(state => {
          delete state.loading[key];
        });
      }
    },

    clearError: workspaceId => {
      const key = `fetch:${workspaceId}`;
      set(state => {
        state.error[key] = null;
      });
    },
  })),
);

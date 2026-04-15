/**
 * Settings Store
 * Manages application settings including AI model selection
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { apiClient } from "../lib/api-client";
import type {
  AIModel,
  ModelListResponse,
  GatewayModelInfo,
  GatewayModelsResponse,
  EnabledModelsResponse,
} from "../lib/api-types";

interface SettingsState {
  // AI Model selection
  selectedModelId: string;
  setSelectedModelId: (modelId: string) => void;

  // Available models (workspace-filtered, used by chat)
  models: AIModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  fetchModels: () => Promise<void>;

  // Gateway model catalog (all models from Vercel gateway)
  gatewayModels: GatewayModelInfo[];
  gatewayModelsLoading: boolean;
  gatewayModelsError: string | null;
  fetchGatewayModels: () => Promise<void>;

  // Workspace enabled model IDs
  enabledModelIds: string[];
  enabledModelsLoading: boolean;
  enabledModelsError: string | null;
  fetchEnabledModels: (workspaceId: string) => Promise<void>;
  saveEnabledModels: (
    workspaceId: string,
    models: Array<{
      id: string;
      name: string;
      provider: string;
      description?: string;
    }>,
  ) => Promise<boolean>;

  // General settings
  theme: "light" | "dark" | "system";
  setTheme: (theme: "light" | "dark" | "system") => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      // Default model — empty string means "use the first available model"
      selectedModelId: "",
      setSelectedModelId: modelId => set({ selectedModelId: modelId }),

      // Models list
      models: [],
      modelsLoading: false,
      modelsError: null,
      fetchModels: async () => {
        set({ modelsLoading: true, modelsError: null });
        try {
          const response = await apiClient.get<
            ModelListResponse | { models: AIModel[] }
          >("/agent/models");

          const models =
            "success" in response
              ? response.models || []
              : response.models || [];

          set({ models });

          if (models.length > 0) {
            const current = get().selectedModelId;
            const isAvailable = models.some(model => model.id === current);
            if (!isAvailable) {
              set({ selectedModelId: models[0].id });
            }
          }
        } catch (error) {
          set({ modelsError: "Failed to load models" });
        } finally {
          set({ modelsLoading: false });
        }
      },

      // Gateway model catalog
      gatewayModels: [],
      gatewayModelsLoading: false,
      gatewayModelsError: null,
      fetchGatewayModels: async () => {
        set({ gatewayModelsLoading: true, gatewayModelsError: null });
        try {
          const response = await apiClient.get<GatewayModelsResponse>(
            "/agent/gateway-models",
          );
          set({ gatewayModels: response.models || [] });
        } catch (error) {
          set({ gatewayModelsError: "Failed to load gateway models" });
        } finally {
          set({ gatewayModelsLoading: false });
        }
      },

      // Workspace enabled models
      enabledModelIds: [],
      enabledModelsLoading: false,
      enabledModelsError: null,
      fetchEnabledModels: async (workspaceId: string) => {
        set({ enabledModelsLoading: true, enabledModelsError: null });
        try {
          const response = await apiClient.get<EnabledModelsResponse>(
            `/workspaces/${workspaceId}/settings/models`,
          );
          set({ enabledModelIds: response.enabledModelIds || [] });
        } catch (error) {
          set({ enabledModelsError: "Failed to load enabled models" });
        } finally {
          set({ enabledModelsLoading: false });
        }
      },
      saveEnabledModels: async (
        workspaceId: string,
        models: Array<{
          id: string;
          name: string;
          provider: string;
          description?: string;
        }>,
      ): Promise<boolean> => {
        try {
          await apiClient.put(`/workspaces/${workspaceId}/settings/models`, {
            models,
          });
          set({ enabledModelIds: models.map(m => m.id) });
          return true;
        } catch (error) {
          return false;
        }
      },

      // Theme defaults to system
      theme: "system",
      setTheme: theme => set({ theme: theme }),
    }),
    {
      name: "settings-storage",
      version: 1,
      migrate: (persisted: unknown, version: number) => {
        const state = persisted as Record<string, unknown>;
        if (version === 0 && state.selectedModelId) {
          const id = state.selectedModelId as string;
          if (!id.includes("/")) {
            let provider = "anthropic";
            if (/^(gpt|o[0-9])/.test(id)) {
              provider = "openai";
            } else if (id.startsWith("gemini")) {
              provider = "google";
            }
            state.selectedModelId = `${provider}/${id}`;
          }
        }
        return state as unknown as SettingsState;
      },
      partialize: state => ({
        selectedModelId: state.selectedModelId,
        theme: state.theme,
      }),
    },
  ),
);

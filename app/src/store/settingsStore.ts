/**
 * Settings Store
 * Manages application settings including AI model selection
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";
import { apiClient } from "../lib/api-client";
import type { AIModel, ModelListResponse } from "../lib/api-types";

interface SettingsState {
  // AI Model selection
  selectedModelId: string;
  setSelectedModelId: (modelId: string) => void;

  // Available models
  models: AIModel[];
  modelsLoading: boolean;
  modelsError: string | null;
  fetchModels: () => Promise<void>;

  // General settings
  theme: "light" | "dark" | "system";
  setTheme: (theme: "light" | "dark" | "system") => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    (set, get) => ({
      // Default model
      selectedModelId: "anthropic/claude-opus-4-6",
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

          // Ensure selected model exists
          if (models.length > 0) {
            const current = get().selectedModelId;
            const isAvailable = models.some(model => model.id === current);
            if (!isAvailable) {
              set({ selectedModelId: models[0].id });
            }
          }
        } catch (error) {
          console.error("[SettingsStore] Failed to fetch models:", error);
          set({ modelsError: "Failed to load models" });
        } finally {
          set({ modelsLoading: false });
        }
      },

      // Theme defaults to system
      theme: "system",
      setTheme: theme => set({ theme: theme }),
    }),
    {
      name: "settings-storage",
      // Only persist specific fields
      partialize: state => ({
        selectedModelId: state.selectedModelId,
        theme: state.theme,
      }),
    },
  ),
);

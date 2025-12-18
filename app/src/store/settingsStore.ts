/**
 * Settings Store
 * Manages application settings including AI model selection
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

interface SettingsState {
  // AI Model selection
  selectedModelId: string;
  setSelectedModelId: (modelId: string) => void;

  // General settings
  theme: "light" | "dark" | "system";
  setTheme: (theme: "light" | "dark" | "system") => void;
}

export const useSettingsStore = create<SettingsState>()(
  persist(
    set => ({
      // Default model
      selectedModelId: "gpt-4o",
      setSelectedModelId: modelId => set({ selectedModelId: modelId }),

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

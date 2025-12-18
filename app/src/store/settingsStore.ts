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

  // Chat version toggle (v1 = original, v3 = AI SDK useChat)
  useChatV3: boolean;
  setUseChatV3: (useV3: boolean) => void;
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

      // Chat version toggle (default to original v1)
      useChatV3: false,
      setUseChatV3: useV3 => set({ useChatV3: useV3 }),
    }),
    {
      name: "settings-storage",
      // Only persist specific fields
      partialize: state => ({
        selectedModelId: state.selectedModelId,
        theme: state.theme,
        useChatV3: state.useChatV3,
      }),
    },
  ),
);

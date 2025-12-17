/**
 * Settings Store
 * Manages application settings including AI agent version preference and model selection
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AgentVersion = "v1" | "v2";

interface SettingsState {
  // Agent version preference
  agentVersion: AgentVersion;
  setAgentVersion: (version: AgentVersion) => void;

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
      // Default to v1 (stable) - users can opt-in to v2 (beta)
      agentVersion: "v1",
      setAgentVersion: version => set({ agentVersion: version }),

      // Default to GPT-5.2 (latest flagship model)
      selectedModelId: "gpt-5.2",
      setSelectedModelId: modelId => set({ selectedModelId: modelId }),

      // Theme defaults to system
      theme: "system",
      setTheme: theme => set({ theme: theme }),
    }),
    {
      name: "settings-storage",
      // Only persist specific fields
      partialize: state => ({
        agentVersion: state.agentVersion,
        selectedModelId: state.selectedModelId,
        theme: state.theme,
      }),
    },
  ),
);

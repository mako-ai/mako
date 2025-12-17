/**
 * Settings Store
 * Manages application settings including AI agent version preference
 */

import { create } from "zustand";
import { persist } from "zustand/middleware";

export type AgentVersion = "v1" | "v2";

interface SettingsState {
  // Agent version preference
  agentVersion: AgentVersion;
  setAgentVersion: (version: AgentVersion) => void;

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

      // Theme defaults to system
      theme: "system",
      setTheme: theme => set({ theme: theme }),
    }),
    {
      name: "settings-storage",
      // Only persist specific fields
      partialize: state => ({
        agentVersion: state.agentVersion,
        theme: state.theme,
      }),
    },
  ),
);

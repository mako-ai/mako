/**
 * Command Palette Store
 *
 * Owns the palette open/closed state and the server-backed console search
 * (network calls live in stores per the frontend guidelines). Everything
 * else the palette shows (open tabs, dashboards, apps, ...) is read from
 * the owning domain stores at render time.
 */

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";
import { apiClient } from "../lib/api-client";

export interface ConsoleSearchResult {
  id: string;
  title: string;
  description: string;
  connectionName?: string;
  databaseName?: string;
  language: string;
  isSaved: boolean;
  score: number;
}

interface CommandPaletteState {
  open: boolean;
  consoleResults: ConsoleSearchResult[];
  searching: boolean;
}

interface CommandPaletteActions {
  openPalette: () => void;
  closePalette: () => void;
  togglePalette: () => void;
  /** Server-side console search (vector + text). Aborts in-flight requests. */
  searchConsoles: (workspaceId: string, query: string) => Promise<void>;
  clearConsoleResults: () => void;
}

type CommandPaletteStore = CommandPaletteState & CommandPaletteActions;

let inFlightSearch: AbortController | null = null;

export const useCommandPaletteStore = create<CommandPaletteStore>()(
  immer((set, get) => ({
    open: false,
    consoleResults: [],
    searching: false,

    openPalette: () =>
      set(state => {
        state.open = true;
      }),

    closePalette: () => {
      inFlightSearch?.abort();
      inFlightSearch = null;
      set(state => {
        state.open = false;
        state.consoleResults = [];
        state.searching = false;
      });
    },

    togglePalette: () => {
      if (get().open) {
        get().closePalette();
      } else {
        get().openPalette();
      }
    },

    searchConsoles: async (workspaceId, query) => {
      inFlightSearch?.abort();
      if (query.trim().length < 2) {
        set(state => {
          state.consoleResults = [];
          state.searching = false;
        });
        return;
      }

      const controller = new AbortController();
      inFlightSearch = controller;
      set(state => {
        state.searching = true;
      });

      try {
        const res = await apiClient.get<{ results?: ConsoleSearchResult[] }>(
          `/workspaces/${workspaceId}/consoles/search`,
          { q: query.trim(), limit: "8" },
          { signal: controller.signal },
        );
        if (controller.signal.aborted) return;
        set(state => {
          state.consoleResults = res.results ?? [];
          state.searching = false;
        });
      } catch (err) {
        if (controller.signal.aborted) return;
        // Search is best-effort UI sugar; swallow errors and show nothing.
        set(state => {
          state.consoleResults = [];
          state.searching = false;
        });
      } finally {
        if (inFlightSearch === controller) {
          inFlightSearch = null;
        }
      }
    },

    clearConsoleResults: () =>
      set(state => {
        state.consoleResults = [];
        state.searching = false;
      }),
  })),
);

import { create } from "zustand";
import { immer } from "zustand/middleware/immer";

interface ConsoleContentEntry {
  content: string;
  connectionId?: string;
  lastFetchedAt: number;
}

interface ConsoleContentState {
  byId: Record<string, ConsoleContentEntry>;
  get: (consoleId: string) => ConsoleContentEntry | undefined;
  set: (
    consoleId: string,
    entry: { content: string; connectionId?: string },
  ) => void;
  clear: (consoleId?: string) => void;
}

export const useConsoleContentStore = create<ConsoleContentState>()(
  immer((set, get) => ({
    byId: {},
    get: consoleId => get().byId[consoleId],
    set: (consoleId, entry) => {
      set(state => {
        state.byId[consoleId] = {
          content: entry.content,
          connectionId: entry.connectionId,
          lastFetchedAt: Date.now(),
        };
      });
    },
    clear: consoleId => {
      set(state => {
        if (consoleId) {
          delete state.byId[consoleId];
        } else {
          state.byId = {};
        }
      });
    },
  })),
);
